FROM node:22-slim

# Install curl and ca-certificates to download the oz CLI
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Install the oz CLI
RUN curl -fsSL "https://releases.warp.dev/stable/v1/oz-linux-x64" \
      -o /usr/local/bin/oz \
 && chmod +x /usr/local/bin/oz

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3847

CMD ["npm", "start"]
