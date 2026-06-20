# Build stage — compile TypeScript to dist/
FROM apify/actor-node:20 AS builder

COPY package*.json ./

RUN npm install --include=dev --audit=false --quiet

COPY . ./

RUN npm run build

# Final stage — production deps only + compiled output
FROM apify/actor-node:20

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

COPY --from=builder /usr/src/app/dist ./dist
COPY . ./

CMD ["npm", "run", "start", "--silent"]
