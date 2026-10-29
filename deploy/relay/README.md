# Hosting a relay

The relay only stores ciphertext, but the relay token travels in the WebSocket URL and in request headers. Over plain HTTP anyone on the path can read it. So `RelayClient` and the plugin refuse an `http://` or `ws://` relay unless the host is loopback (`127.0.0.0/8`, `::1`, `localhost`) or `CMA_ALLOW_INSECURE_RELAY=1` is set. Use that override only on a network that is already encrypted, such as a tailnet.

The image is `deploy/relay/Dockerfile`: `oven/bun` pinned by version, non-root user, SQLite at `/data/relay.sqlite` on a volume, listening on `0.0.0.0:8787`. Build it from the repository root:

```bash
docker build -f deploy/relay/Dockerfile -t cma-relay .
docker run -d --name cma-relay -p 127.0.0.1:8787:8787 -v cma-relay-data:/data cma-relay
curl http://127.0.0.1:8787/v1/health   # {"ok":true}
```

Extra arguments are appended to the `cma relay` command, so `docker run ... cma-relay --trust-proxy` turns on proxy mode.

`--trust-proxy` makes the relay rate-limit room creation by the left-most `X-Forwarded-For` value instead of the socket address. Pass it only when a proxy you control sets that header; otherwise any client can spoof it and dodge the limit.

## Option 1: Tailscale (no TLS, override required)

Traffic between tailnet nodes is already encrypted by WireGuard, so plain HTTP over the tailnet is acceptable.

On the machine that hosts the relay (both machines are on the same tailnet):

```bash
docker run -d --name cma-relay --restart unless-stopped \
  -p "$(tailscale ip -4):8787:8787" -v cma-relay-data:/data cma-relay
tailscale ip -4        # e.g. 100.101.102.103
```

On both engineers' machines:

```bash
export CMA_ALLOW_INSECURE_RELAY=1
export CMA_RELAY_URL=http://100.101.102.103:8787      # or http://<machine-name>:8787 with MagicDNS
cma session ~/src/orders-service --exec
```

Without Docker: `cma relay --host "$(tailscale ip -4)" --port 8787 --db ~/.cma-relay.sqlite`.

## Option 2: Fly.io (TLS terminated by Fly)

```bash
fly auth login
# edit `app` in deploy/relay/fly.toml to a unique name first
fly apps create my-cma-relay
fly volumes create cma_relay_data --app my-cma-relay --region ams --size 1
fly deploy --config deploy/relay/fly.toml --dockerfile deploy/relay/Dockerfile --app my-cma-relay
curl https://my-cma-relay.fly.dev/v1/health
```

Keep a single machine: the relay holds live sockets in memory and the SQLite file lives on one volume. Then, on both machines:

```bash
export CMA_RELAY_URL=https://my-cma-relay.fly.dev
```

## Option 3: Any VPS behind Caddy

Point a DNS record (`relay.example.com`) at the VPS and open ports 80 and 443. Caddy obtains and renews the certificate itself.

```bash
# On the VPS (Debian/Ubuntu with Docker and Caddy installed)
git clone https://github.com/joaomcarvalho/call-my-agent.git && cd call-my-agent
docker build -f deploy/relay/Dockerfile -t cma-relay .
docker run -d --name cma-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v cma-relay-data:/data cma-relay --trust-proxy

sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
relay.example.com {
	reverse_proxy 127.0.0.1:8787
}
EOF
sudo systemctl reload caddy
curl https://relay.example.com/v1/health
```

Caddy proxies WebSockets without extra configuration and sets `X-Forwarded-For` to the client address. Then, on both machines:

```bash
export CMA_RELAY_URL=https://relay.example.com
```

## Backups and limits

Rooms expire with their invite (at most 3 days) and are purged a week later, so the volume needs no backup; losing it only ends calls in flight. The relay has no accounts: anyone who can reach it can create rooms, limited to 20 per minute per client IP.
