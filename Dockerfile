FROM node:20-slim AS builder
WORKDIR /workspace

# git is required by @whiskeysockets/baileys during install
RUN apt-get update -qq && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# copy package & lock first for caching
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# copy source
COPY . .

# compile
RUN npm run compile

# remove devDependencies so node_modules only contains runtime deps (smaller VSIX)
# override vscode:prepublish to skip re-compile (already compiled above)
RUN npm prune --omit=dev && npm pkg set scripts.vscode:prepublish="echo already-compiled"

# ensure output directory exists, then package
RUN mkdir -p /workspace/dist && npm run package

FROM scratch AS export
COPY --from=builder /workspace/dist/ /
