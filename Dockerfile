FROM node:18-slim

# Install only runtime timezone data
RUN apt-get update && apt-get install -y tzdata \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

ENV TZ=UTC

CMD ["npm", "start"]
