# M3AK

Agent commercial conversationnel pour les commerçants marocains, développé dans le cadre du hackathon **ESISA × Numeos Technology 2026** (Sujet 02 — Kenza).

M3AK comprend et répond en darija, arabe et français, et vise à transformer une conversation client en commande fiable, sans inventer de prix, de stock, de délai ou de promotion.

## Stack actuelle

- **Frontend** : React 18, TypeScript, Vite
- **API** : Node.js 20+, TypeScript, Fastify
- **Worker** : Node.js 20+, TypeScript
- **Shared** : package TypeScript partagé (contrats à venir)

> Cette base ne contient pour l'instant aucune logique métier, aucune base de données et aucun agent conversationnel. Ces éléments seront ajoutés lors des tâches suivantes.

## Structure principale

```text
m3ak/
├── apps/
│   ├── web/       # application React (interface)
│   ├── api/       # serveur Fastify
│   └── worker/    # worker Node.js
├── packages/
│   └── shared/    # package partagé (contrats communs à venir)
├── data/
│   └── raw/       # dataset officiel (à venir)
└── docs/          # documentation complémentaire
```

## Prérequis

- Node.js >= 20.19.0
- npm >= 10
- Docker Desktop / Docker Engine avec Docker Compose (pour l'environnement conteneurisé)

## Commandes disponibles

```bash
npm install       # installe les dépendances de tous les workspaces
npm run typecheck # vérifie les types sur tous les workspaces
npm run build     # build tous les workspaces
```

Par workspace :

```bash
npm run dev --workspace @m3ak/web    # démarre le frontend en développement
npm run start --workspace @m3ak/api  # démarre l'API après build
```

## Environnement Docker

Cinq services : `web`, `api`, `worker`, `postgres`, `redis`.

> Le worker ne fait pour l'instant que rester actif (infrastructure provisoire) :
> aucune file de tâches réelle n'existe encore.

Démarrer l'ensemble :

```bash
docker compose up -d --build
```

Arrêter l'ensemble :

```bash
docker compose down
```

Ports exposés sur l'hôte :

- web : http://localhost:5173
- api : http://localhost:3001
- postgres : localhost:5432 (développement local uniquement)
- redis : localhost:6379 (développement local uniquement)

Logs utiles :

```bash
docker compose ps
docker compose logs --tail=100
docker compose logs -f api
```

### Routes API

- `GET /` — identification simple du service (`{"service":"m3ak-api"}`).
- `GET /health` — vérifie réellement la disponibilité de PostgreSQL (`SELECT 1`) et de Redis (`PING`) :
  - `200` si PostgreSQL **et** Redis répondent ;
  - `503` si l'une des deux dépendances ne répond pas.

  ```json
  {
    "status": "healthy",
    "checks": { "api": "healthy", "postgres": "healthy", "redis": "healthy" }
  }
  ```

  Le service Docker `api` est marqué `healthy` uniquement lorsque `GET /health` répond `200`.

## Documentation

- [Spécification produit](spec.md)
- [Conception technique](design.md)
- [Plan d'exécution](tasks.md)
- [Règles pour Claude Code](CLAUDE.md)
