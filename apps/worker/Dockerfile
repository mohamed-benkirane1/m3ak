# M3AK — worker (infrastructure provisoire, aucune file de tâches pour l'instant)
FROM node:20.19.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY . .

RUN npm run build --workspace @m3ak/worker

CMD ["npm", "run", "start", "--workspace", "@m3ak/worker"]
