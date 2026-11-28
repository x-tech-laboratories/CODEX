// The Web tool plugin: the address guard on its own, reading pages from a fake web server and searching a fake SearXNG
// instance, both on random ports on this machine, which only the tests' own allowance lets the guard reach.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { checked_web_address, is_public_address, ports_of, public_addresses } from "../../../src/server/tools/address_guard.ts";
import { fetch_page, search_address, search_web, web_plugin, web_tools, type WebOptions } from "../../../src/server/tools/web.ts";
import { use_assistant_host } from "../../../src/shared/conversations/host.ts";
import { wait_for_runs } from "../../../src/shared/conversations/run.ts";
import { html_to_text, unescape_html } from "../../../src/shared/tools/html_text.ts";
import { start_fixture } from "../../fixtures/assistant_fixture.ts";

afterEach(async () => {
  await wait_for_runs();
  use_assistant_host(null);
});

// ── The guard ────────────────────────────────────────────────────────────────

describe("the address guard", () => {
  it("knows public addresses from loopback, private, link-local and other ranges, in IPv4 and IPv6", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) expect(is_public_address(address), address).toBe(true);
    for (const address of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "2001:db8::1", "fe80::1%eth0", "not an address",
    ]) {
      expect(is_public_address(address), address).toBe(false);
    }
  });

  it("takes only whole http and https addresses, without a name or password, on the usual ports unless allowed", () => {
    expect(checked_web_address("https://example.org/a#b").href).toBe("https://example.org/a");
    expect(checked_web_address("http://example.org:80/").href).toBe("http://example.org/");
    expect(() => checked_web_address("example.org")).toThrow("Give a whole web address");
    expect(() => checked_web_address("file:///etc/passwd")).toThrow("Only http and https addresses can be read, not file.");
    expect(() => checked_web_address("ftp://example.org/")).toThrow("not ftp");
    expect(() => checked_web_address(["https://someone", "word@example.org/"].join(":"))).toThrow("name or password");
    expect(() => checked_web_address("https://someone@example.org/")).toThrow("name or password");
    expect(() => checked_web_address("https://example.org:8443/")).toThrow("Port 8443 is not allowed");
    expect(checked_web_address("https://example.org:8443/", { allowed_ports: ports_of("8080, 8443") }).port).toBe("8443");
    expect([...ports_of("80 x 70000, 8080;-1")]).toEqual([80, 8080]);
  });

  it("refuses a name that resolves to any address not public, and lets a test allow one only by its own allowance", async () => {
    const answers: Record<string, string[]> = { "public.test": ["93.184.216.34"], "mixed.test": ["93.184.216.34", "10.0.0.5"], "nothing.test": [] };
    const resolve = async (host: string) => answers[host] ?? Promise.reject(new Error("NXDOMAIN"));
    expect(await public_addresses("public.test", { resolve })).toEqual(["93.184.216.34"]);
    await expect(public_addresses("mixed.test", { resolve })).rejects.toThrow("mixed.test is not a public address (it leads to 10.0.0.5)");
    await expect(public_addresses("nothing.test", { resolve })).rejects.toThrow("could not be found");
    await expect(public_addresses("gone.test", { resolve })).rejects.toThrow("The host gone.test could not be found.");
    await expect(public_addresses("[::1]", { resolve })).rejects.toThrow("is not a public address");
    await expect(public_addresses("127.0.0.1")).rejects.toThrow("is not a public address");
    expect(await public_addresses("127.0.0.1", { allow_address: (address) => address === "127.0.0.1" })).toEqual(["127.0.0.1"]);
    await expect(public_addresses("127.0.0.2", { allow_address: (address) => address === "127.0.0.1" })).rejects.toThrow("is not a public address");
  });
});

// ── Page text ────────────────────────────────────────────────────────────────

describe("a page's readable text", () => {
  it("is its title, then a block to a line, links as plain text with their addresses, scripts and styles left out", () => {
    const page = html_to_text(
      `<html><head><title>Tiles &amp; grout</title><style>p{color:red}</style><script>alert("<p>x</p>")</script></head>
       <body><h1>Laying tiles</h1><p>Start <b>from</b> the middle.<br>Use <a href="/spacers">spacers</a> and <a href="https://example.org/grout">https://example.org/grout</a>.</p>
       <ul><li>One</li><li>Two &#8217;s</li></ul><!-- hidden --><svg><text>drawing</text></svg><a href="mailto:a@b.c">mail</a><a href="/empty"></a></body></html>`,
      "https://tiles.example/guide/",
    );
    expect(page.title).toBe("Tiles & grout");
    expect(page.text).toBe(["Laying tiles", "Start from the middle.", "Use spacers (https://tiles.example/spacers) and https://example.org/grout.", "One", "Two ’s", "mailhttps://tiles.example/empty"].join("\n"));
    expect(unescape_html("&lt;&#x41;&#0;&unknown;&NBSP;")).toBe("<A�&unknown; ");
    expect(html_to_text("<p>Unclosed <script>never closed").text).toBe("Unclosed");
  });
});

// ── Fake servers ─────────────────────────────────────────────────────────────

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let port = 0;
let handle: Handler = (_request, response) => response.end();
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(request.url ?? "");
    handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

// The fake web: pages.test is the fake server on loopback, which only this allowance lets through; rebind.test answers
// with a public address when checked and a private one when connected; inside.test is private.
function web_options(extra: WebOptions = {}): WebOptions {
  let rebinds = 0;
  return {
    resolve: async (host) => {
      if (host === "pages.test") return ["127.0.0.1"];
      if (host === "inside.test") return ["192.168.1.5"];
      if (host === "rebind.test") return (rebinds += 1) === 1 ? ["93.184.216.34"] : ["10.0.0.7"];
      throw new Error("NXDOMAIN");
    },
    allow_address: (address) => address === "127.0.0.1",
    timeout_ms: 2000,
    ...extra,
  };
}

const settings = () => ({ allowed_ports: String(port), search_endpoint: "" });
const signal = () => new AbortController().signal;

describe("web_fetch", () => {
  it("reads a page's title and text, following a redirect that is checked again", async () => {
    handle = (request, response) => {
      if (request.url === "/old") return void response.writeHead(301, { Location: "/guide" }).end();
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>Guide</title><p>Read <a href="/more">more</a>.</p>`);
    };
    const text = await fetch_page(`http://pages.test:${port}/old`, settings(), signal(), web_options());
    expect(text).toBe([`Address: http://pages.test:${port}/guide`, "Title: Guide", "", `Read more (http://pages.test:${port}/more).`].join("\n"));
  });

  it("refuses a redirect to a private address, by number or by name, and a name that changes its answer when connected", async () => {
    handle = (request, response) => {
      const to = request.url === "/to-number" ? "http://10.0.0.1/admin" : request.url === "/to-name" ? `http://inside.test/` : request.url === "/to-port" ? "http://pages.test:1/" : "";
      response.writeHead(302, { Location: to }).end();
    };
    await expect(fetch_page(`http://pages.test:${port}/to-number`, settings(), signal(), web_options())).rejects.toThrow("10.0.0.1 is not a public address");
    await expect(fetch_page(`http://pages.test:${port}/to-name`, settings(), signal(), web_options())).rejects.toThrow("inside.test is not a public address (it leads to 192.168.1.5)");
    await expect(fetch_page(`http://pages.test:${port}/to-port`, settings(), signal(), web_options())).rejects.toThrow("Port 1 is not allowed");
    await expect(fetch_page(`http://rebind.test:${port}/`, settings(), signal(), web_options())).rejects.toThrow("rebind.test is not a public address (it leads to 10.0.0.7)");
  });

  it("never reaches this machine without the test's allowance, nor a port the user did not allow", async () => {
    const before = seen.length;
    const { allow_address: _, ...without } = web_options();
    await expect(fetch_page(`http://127.0.0.1:${port}/`, settings(), signal(), without)).rejects.toThrow("is not a public address");
    await expect(fetch_page(`http://pages.test:${port}/`, settings(), signal(), without)).rejects.toThrow("is not a public address");
    await expect(fetch_page(`http://pages.test:${port}/`, {}, signal(), web_options())).rejects.toThrow(`Port ${port} is not allowed`);
    expect(seen.length).toBe(before);
  });

  it("cuts a long page short, refuses what is not a page, says a failing status and stops a page that does not answer", async () => {
    handle = (request, response) => {
      if (request.url === "/long") return void response.writeHead(200, { "Content-Type": "text/plain" }).end("word ".repeat(10_000));
      if (request.url === "/image") return void response.writeHead(200, { "Content-Type": "image/png" }).end("png");
      if (request.url === "/missing") return void response.writeHead(404, "Not Found").end();
      if (request.url === "/loop") return void response.writeHead(302, { Location: "/loop" }).end();
      if (request.url === "/odd") return void response.writeHead(200, { "Content-Type": "text/plain; charset=bogus" }).end("plain");
    };
    const long = await fetch_page(`http://pages.test:${port}/long`, settings(), signal(), web_options({ max_chars: 100 }));
    expect(long.endsWith("[Cut short: the page goes on.]")).toBe(true);
    expect(long.length).toBeLessThan(250);
    const capped = await fetch_page(`http://pages.test:${port}/long`, settings(), signal(), web_options({ max_bytes: 50 }));
    expect(capped).toContain("[Cut short: the page goes on.]");
    expect(await fetch_page(`http://pages.test:${port}/odd`, settings(), signal(), web_options())).toContain("plain");
    await expect(fetch_page(`http://pages.test:${port}/image`, settings(), signal(), web_options())).rejects.toThrow("The page is image/png, which web_fetch does not read");
    await expect(fetch_page(`http://pages.test:${port}/missing`, settings(), signal(), web_options())).rejects.toThrow("The page answered HTTP 404 Not Found.");
    await expect(fetch_page(`http://pages.test:${port}/loop`, settings(), signal(), web_options())).rejects.toThrow("redirected more than 5 times");
    await expect(fetch_page(`http://pages.test:${port}/silent`, settings(), signal(), web_options({ timeout_ms: 200 }))).rejects.toThrow("The page did not answer within 0.2 seconds.");
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    await expect(fetch_page(`http://pages.test:${port}/silent`, settings(), stop.signal, web_options())).rejects.toThrow("Stopped.");
  });
});

describe("web_search", () => {
  it("asks a SearXNG instance for JSON and gives back titles, addresses and snippets", async () => {
    handle = (request, response) => {
      if (!request.url?.startsWith("/searx/search")) return void response.writeHead(404).end();
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ results: [{ title: "Tiles", url: "https://example.org/tiles", content: "All about   tiles." }, { url: "https://example.org/bare" }, { title: "No address" }] }),
      );
    };
    const endpoint = `http://127.0.0.1:${port}/searx/`;
    expect(search_address(endpoint, "a b").href).toBe(`http://127.0.0.1:${port}/searx/search?q=a+b&format=json`);
    expect(search_address(`http://127.0.0.1:${port}/searx/search`, "x").pathname).toBe("/searx/search");
    const text = await search_web(endpoint, "laying tiles", signal(), web_options());
    expect(seen.at(-1)).toBe("/searx/search?q=laying+tiles&format=json");
    expect(text).toBe(["Results for “laying tiles”:", "1. Tiles", "   https://example.org/tiles", "   All about tiles.", "2. (no title)", "   https://example.org/bare"].join("\n"));
  });

  it("says plainly when the endpoint is wrong, refuses JSON, answers nothing or finds nothing", async () => {
    expect(() => search_address("searx", "x")).toThrow("not a whole address");
    expect(() => search_address("ftp://searx/", "x")).toThrow("must be an http or https address");
    handle = (request, response) => {
      if (request.url?.startsWith("/forbidden")) return void response.writeHead(403).end();
      if (request.url?.startsWith("/html")) return void response.writeHead(200, { "Content-Type": "text/html" }).end("<p>no</p>");
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ results: [] }));
    };
    await expect(search_web(`http://127.0.0.1:${port}/forbidden`, "x", signal(), web_options())).rejects.toThrow("turn on SearXNG's JSON format");
    await expect(search_web(`http://127.0.0.1:${port}/html`, "x", signal(), web_options())).rejects.toThrow("did not answer with JSON");
    expect(await search_web(`http://127.0.0.1:${port}/empty`, "x", signal(), web_options())).toBe("No results for “x”.");
    handle = () => undefined;
    await expect(search_web(`http://127.0.0.1:${port}/silent`, "x", signal(), web_options({ timeout_ms: 200 }))).rejects.toThrow("The search endpoint did not answer within 0.2 seconds.");
  });
});

describe("the Web plugin", () => {
  it("offers web_search only once an endpoint is set, and checks what it is given", async () => {
    let values: Record<string, string> = { search_endpoint: "", allowed_ports: "" };
    const plugin = web_tools(() => values, web_options());
    expect((await plugin.tools()).map((tool) => [tool.name, tool.changes, tool.sends_outside])).toEqual([["web_fetch", false, true]]);
    await expect(plugin.call("web_search", { query: "x" }, signal())).rejects.toThrow("No search endpoint is set");
    values = { search_endpoint: "http://127.0.0.1:1", allowed_ports: "" };
    expect((await plugin.tools()).map((tool) => tool.name)).toEqual(["web_fetch", "web_search"]);
    await expect(plugin.call("web_fetch", {}, signal())).rejects.toThrow("Give the page's address as url.");
    await expect(plugin.call("web_search", { query: " " }, signal())).rejects.toThrow("Give what to search for as query.");
    await expect(plugin.call("web_other", {}, signal())).rejects.toThrow("The Web plugin has no tool named web_other.");
  });

  it("is off until turned on, then offers its tools to a run, which reads a page as outside content and logs the send", async () => {
    handle = (_request, response) => void response.writeHead(200, { "Content-Type": "text/html" }).end("<title>Tiles</title><p>Grout dries in a day.</p>");
    const fixture = start_fixture({ plugins: [web_plugin(web_options())] });
    expect(await fixture.calls.list_plugin_tools()).toEqual([]);
    fixture.calls.set_setting("plugins", { "codex.web": { enabled: true, settings: { allowed_ports: String(port), search_endpoint: "" } } });
    expect((await fixture.calls.list_plugin_tools()).map((entry) => [entry.key, entry.tools.map((tool) => tool.name)])).toEqual([["codex.web/web", ["web__web_fetch"]]]);
    const results: string[] = [];
    fixture.set_script(async function* (request) {
      expect(request.instructions).toContain("Never put personal details");
      results.push((await request.tools.call("web__web_fetch", { url: `http://pages.test:${port}/tiles` })).result);
      yield { type: "done", text: "Grout dries in a day." };
    });
    const { conversation_id } = await fixture.calls.send_message(null, "How long does grout take?");
    await wait_for_runs();
    expect(results[0]).toContain("<untrusted-data>\nAddress: http://pages.test");
    expect(results[0]).toContain("Grout dries in a day.");
    expect(fixture.calls.get_conversation(conversation_id).messages[1]!.sources).toEqual(["tool:codex.web/web"]);
    expect(fixture.calls.list_hosted_sends()).toMatchObject([{ kind: "tool", tool: "Web: web_fetch", argument_count: 1 }]);
  });
});
