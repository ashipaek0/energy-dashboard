FROM node:22-slim

# Build tools for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data && chown -R node:node /app
WORKDIR /app

COPY package*.json ./
RUN npm install --production && npm install -g npm@11.13.0

COPY --chown=node:node . .

USER node
EXPOSE 3000
CMD ["npm", "start"]
