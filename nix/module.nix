self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.codex;
  desktop = config.programs.codex;
  declared = desktop.declared;
  json = pkgs.formats.json { };
  inherit (lib)
    literalExpression
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  state_directory = "/var/lib/codex";

  config_file = json.generate "codex.json" {
    database = "${state_directory}/codex.db";
    backups_folder = "${state_directory}/backups";
  };

  # A secret is only ever the path of a file read at run time, never its content.
  secret_file = mkOption {
    type = types.nullOr types.str;
    default = null;
    description = "The path of a file holding the secret, which CODEX reads each time it needs it. A string, not a Nix path, which would copy the secret into the store.";
  };

  plugin_settings =
    extra:
    types.submodule {
      freeformType = json.type;
      options = extra;
    };

  without_nulls = lib.filterAttrsRecursive (_: value: value != null);

  declared_json = without_nulls {
    engines = lib.mapAttrs (_: without_nulls) declared.engines;
    inherit (declared) engine embedder web;
    sources = lib.mapAttrs (_: without_nulls) declared.sources;
    mcp_servers = map (
      server:
      without_nulls {
        inherit (server)
          id
          name
          address
          command
          args
          ;
        token_file = server.tokenFile;
      }
    ) declared.mcpServers;
  };

  is_declared =
    declared.engines != { }
    || declared.engine != null
    || declared.embedder != null
    || declared.sources != { }
    || declared.web != null
    || declared.mcpServers != [ ];

  secret_paths =
    lib.mapAttrsToList (_: engine: engine.key_file) declared.engines
    ++ lib.optional (declared.embedder != null) declared.embedder.key_file
    ++ lib.mapAttrsToList (_: source: source.token_file) declared.sources
    ++ map (server: server.tokenFile) declared.mcpServers;

  declared_path = "/etc/codex/declared.json";
in
{
  options.programs.codex = {
    enable = mkEnableOption "the CODEX desktop app, for every user of this machine";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.desktop;
      defaultText = literalExpression "codex desktop (from flake)";
      description = "The CODEX desktop package to install.";
    };

    declared = {
      engines = mkOption {
        type = types.attrsOf (plugin_settings { key_file = secret_file; });
        default = { };
        example = literalExpression ''{ "codex.openai" = { endpoint = "http://127.0.0.1:8080/v1"; model = "qwen3-8b"; context_size = 16384; }; }'';
        description = "Engine plugins by id (codex.anthropic, codex.openai, codex.smartharness), each with its settings and the file holding its API key as key_file. Its model is the default: the owner can choose another from the endpoint's list in CODEX, kept on that device; every other setting stays as declared.";
      };

      engine = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "openai";
        description = "The engine that answers (anthropic, openai or smartharness); left null, a lone declared engine answers.";
      };

      embedder = mkOption {
        type = types.nullOr (plugin_settings { key_file = secret_file; });
        default = null;
        example = literalExpression ''{ endpoint = "http://127.0.0.1:11434/v1"; model = "nomic-embed-text"; dimensions = 768; }'';
        description = "The OpenAI-compatible embedder the search index uses, with the file holding its API key as key_file.";
      };

      sources = mkOption {
        type = types.attrsOf (plugin_settings { token_file = secret_file; });
        default = { };
        example = literalExpression ''{ "codex.x-tasks" = { address = "https://tasks.example.org"; token_file = config.sops.secrets.x_tasks_token.path; }; }'';
        description = "The X-Tasks and Trilium collectors (codex.x-tasks, codex.trilium), each with its address and the file holding its read-only token as token_file.";
      };

      web = mkOption {
        type = types.nullOr (plugin_settings { });
        default = null;
        example = literalExpression ''{ search_endpoint = "https://searx.example.org"; }'';
        description = "The Web plugin's settings, such as the SearXNG instance web_search asks; declaring it turns the plugin on.";
      };

      mcpServers = mkOption {
        type = types.listOf (
          types.submodule {
            options = {
              id = mkOption {
                type = types.strMatching "[a-z0-9]+(-[a-z0-9]+)*";
                description = "The server's id; its tools are named mcp_cfg-<id>__<tool>.";
              };
              name = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "What CODEX calls the server; its id unless set.";
              };
              address = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "Where it answers MCP over streamable HTTP.";
              };
              tokenFile = secret_file;
              command = mkOption {
                type = types.nullOr types.str;
                default = null;
                description = "The program that starts it over stdio, in place of an address.";
              };
              args = mkOption {
                type = types.listOf types.str;
                default = [ ];
                description = "The program's arguments.";
              };
            };
          }
        );
        default = [ ];
        description = "MCP servers whose tools the assistant is offered, under the action policy like any other server's.";
      };
    };
  };

  options.services.codex = {
    enable = mkEnableOption "CODEX, a web app of contexts gathering items from other apps, that its devices sync with";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = literalExpression "codex (from flake)";
      description = "The CODEX package to use.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Address the page, API and sync listen on.";
    };

    port = mkOption {
      type = types.port;
      default = 7770;
      description = "Port the page, API and sync listen on.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the port in the firewall.";
    };

    passwordHashFile = mkOption {
      type = types.str;
      example = "/etc/codex/password-hash";
      description = ''
        The accounts file: one `name:hash` line per admin, from `npm run hash-password`. Admins add other users on the
        Users page.
      '';
    };
  };

  config = lib.mkMerge [
    {
      assertions = map (path: {
        assertion = path == null || !(lib.hasPrefix builtins.storeDir path);
        message = "programs.codex.declared names a secret file in the Nix store (${toString path}); give the path of a file outside it, such as one sops-nix writes.";
      }) secret_paths;
    }

    (mkIf desktop.enable { environment.systemPackages = [ desktop.package ]; })

    # Every desktop daemon on this machine reads it, and the server when it runs here; it holds paths, never secrets.
    (mkIf is_declared { environment.etc."codex/declared.json".source = json.generate "codex-declared.json" declared_json; })

    (mkIf cfg.enable {
      systemd.services.codex = {
        description = "CODEX";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];

        environment = {
          CODEX_CONFIG = toString config_file;
          CODEX_HOST = cfg.host;
          CODEX_PORT = toString cfg.port;
          CODEX_PASSWORD_HASH_FILE = "%d/password-hash";
        }
        // lib.optionalAttrs is_declared { CODEX_DECLARED_FILE = declared_path; };

        serviceConfig = {
          ExecStart = lib.getExe cfg.package;
          DynamicUser = true;
          StateDirectory = "codex";
          StateDirectoryMode = "0700";
          LoadCredential = [ "password-hash:${cfg.passwordHashFile}" ];
          Restart = "always";
          RestartSec = "5s";

          CapabilityBoundingSet = "";
          LockPersonality = true;
          NoNewPrivileges = true;
          PrivateDevices = true;
          ProtectClock = true;
          ProtectControlGroups = true;
          ProtectHome = true;
          ProtectHostname = true;
          ProtectKernelLogs = true;
          ProtectKernelModules = true;
          ProtectKernelTunables = true;
          ProtectSystem = "strict";
          RestrictAddressFamilies = [
            "AF_INET"
            "AF_INET6"
            "AF_UNIX"
          ];
          RestrictNamespaces = true;
          RestrictRealtime = true;
          SystemCallArchitectures = "native";
          SystemCallFilter = [ "@system-service" ];
          UMask = "0077";
        };
      };

      networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];
    })
  ];
}
