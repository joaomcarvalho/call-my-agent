# Build from the repository root: docker build -f deploy/relay/Dockerfile -t cma-relay .
FROM oven/bun:1.3.1

WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY plugin ./plugin
COPY bin ./bin
RUN bun install --frozen-lockfile --production

RUN mkdir /data && chown bun:bun /data
VOLUME /data
USER bun
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "const r = await fetch('http://127.0.0.1:8787/v1/health'); process.exit(r.ok ? 0 : 1)"

ENTRYPOINT ["bun", "bin/cma", "relay", "--host", "0.0.0.0", "--port", "8787", "--db", "/data/relay.sqlite"]
