FROM node:18-alpine

# Create app directory and set ownership to the 'node' user
RUN mkdir -p /app/data && chown -R node:node /app
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
RUN npm install --production

# Copy the rest of the app
COPY --chown=node:node . .

# Switch to non-root user
USER node

EXPOSE 3000
CMD ["npm", "start"]
