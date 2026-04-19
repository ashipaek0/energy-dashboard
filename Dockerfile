FROM node:18-alpine

# Install tzdata for timezone support
RUN apk add --no-cache tzdata

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

# Set default timezone (override with TZ environment variable)
ENV TZ=UTC

CMD ["npm", "start"]
