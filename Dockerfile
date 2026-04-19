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

# Remove any existing prebuilt sqlite3 binary, then rebuild from source
RUN rm -rf /app/node_modules/sqlite3/build && \
    npm rebuild sqlite3 --build-from-source

# Remove build tools to reduce image size
RUN apt-get purge -y python3 make g++ && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

ENV TZ=UTC

CMD ["npm", "start"]
