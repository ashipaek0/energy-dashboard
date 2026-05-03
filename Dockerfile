FROM node:22-slim

# Install build tools needed for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Create app directory and set ownership
RUN mkdir -p /app/data && chown -R node:node /app
WORKDIR /app

# Install dependencies (npm 10.x, already present, is fine)
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY --chown=node:node . .

# Run as non‑root user
USER node

EXPOSE 3000
CMD ["npm", "start"]
