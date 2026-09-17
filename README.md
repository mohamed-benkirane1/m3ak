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

- Node.js >= 20
- npm >= 10

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

## Documentation

- [Spécification produit](spec.md)
- [Conception technique](design.md)
- [Plan d'exécution](tasks.md)
- [Règles pour Claude Code](CLAUDE.md)
