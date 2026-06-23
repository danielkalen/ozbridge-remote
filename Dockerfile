FROM node:22-slim

# Install curl and ca-certificates to download the oz CLI
RUN apt-get update && apt-get install -y \n    curl \n    ca-certificates \n    --no-install-recommends \n && rm -rf /var/lib/apt/lists/*

# Install the oz CLI
# Find the current Linux binary URL at https://www.warp.dev/
# Common patterns (verify before deploying):
#   https://releases.warp.dev/stable/v1/oz-linux-x64
#   https://app.warp.dev/get_warp?package=oz-cli-linux
RUN curl -fsSL "https://releases.warp.dev/stable/v1/oz-linux-x64" \n      -o /usr/local/bin/oz \n && chmod +x /usr/local/bin/oz

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3847

CMD ["npm", "start"]