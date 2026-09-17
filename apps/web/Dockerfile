# M3AK — web (React/Vite)
# Image de développement/hackathon : sert le build de production via `vite preview`.
FROM node:20.19.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY . .

RUN npm run build --workspace @m3ak/web

EXPOSE 5173

CMD ["npm", "run", "preview", "--workspace", "@m3ak/web"]
