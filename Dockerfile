FROM node:22-slim

# Install oz CLI via apt (official Warp repository)
RUN apt-get update && apt-get install -y \
    wget \
    gpg \
    --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && wget -qO- https://releases.warp.dev/linux/keys/warp.asc | gpg --dearmor > warpdotdev.gpg \
 && install -D -o root -g root -m 644 warpdotdev.gpg /etc/apt/keyrings/warpdotdev.gpg \
 && sh -c 'echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/warpdotdev.gpg] https://releases.warp.dev/linux/deb stable main" > /etc/apt/sources.list.d/warpdotdev.list' \
 && rm warpdotdev.gpg \
 && apt-get update \
 && apt-get install -y oz-stable --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3847

CMD ["npm", "start"]
