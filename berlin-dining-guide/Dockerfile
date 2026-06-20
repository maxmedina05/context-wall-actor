FROM apify/actor-node:20

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false \
    && echo "Node.js version:" \
    && node --version

COPY . ./

CMD ["npm", "start", "--silent"]
