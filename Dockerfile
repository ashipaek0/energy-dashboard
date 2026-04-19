FROM node:18-slim

# Install build tools and tzdata
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    tzdata \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# Rebuild native modules to match the container's glibc
RUN npm rebuild sqlite3 --update-binary

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

ENV TZ=UTC

CMD ["npm", "start"]
