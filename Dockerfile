FROM node:20-slim AS builder
WORKDIR /workspace

# copy package & lock first for caching
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# copy source
COPY . .

# compile
RUN npm run compile

# ensure output directory exists, then package
RUN mkdir -p /workspace/dist && npm run package

FROM scratch AS export
COPY --from=builder /workspace/dist/ /
