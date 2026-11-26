// Whether a model answers on the user's own machine or network, or at a hosted service: an endpoint is local when its
// host is a loopback or private-network address, and hosted otherwise.

// ── Addresses ────────────────────────────────────────────────────────────────

// The four numbers of an IPv4 address, or null for anything else.
function ipv4_parts(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((number) => number <= 255) ? numbers : null;
}

// Loopback (127/8), private (10/8, 172.16/12, 192.168/16) or link-local (169.254/16).
function is_local_ipv4([first, second]: number[]): boolean {
  return first === 127 || first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}

// Loopback (::1), unique local (fc00::/7), link-local (fe80::/10) or an IPv4 address mapped into IPv6.
function is_local_ipv6(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) {
    const parts = ipv4_parts(mapped[1]!);
    return parts !== null && is_local_ipv4(parts);
  }
  // The same, as URL writes it: two groups of hex, such as ::ffff:c0a8:102 for 192.168.1.2.
  const mapped_hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (mapped_hex) {
    const [high, low] = [parseInt(mapped_hex[1]!, 16), parseInt(mapped_hex[2]!, 16)];
    return is_local_ipv4([high >> 8, high & 255, low >> 8, low & 255]);
  }
  return /^f[cd][0-9a-f]{0,2}:/.test(bare) || /^fe[89ab][0-9a-f]?:/.test(bare);
}

// Whether the endpoint's host is loopback or a private-network address; an empty or unreadable endpoint is not.
export function is_local_endpoint(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const parts = ipv4_parts(host);
  if (parts) return is_local_ipv4(parts);
  return host.includes(":") && is_local_ipv6(host);
}
