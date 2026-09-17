# M3AK — Conception technique

**Hackathon :** ESISA × Numeos Technology 2026
**Sujet officiel :** Sujet 02 — Kenza
**Produit :** M3AK
**Version :** 0.1
**Statut :** Architecture MVP

---

## 1. Objectif

M3AK doit être un véritable agent commercial, pas un simple chatbot.

Une interaction doit pouvoir suivre :

message client
→ compréhension structurée
→ récupération du contexte pertinent
→ décision sur l'action suivante
→ appel d'outils métier
→ vérification des garde-fous
→ mise à jour de l'état
→ création éventuelle d'une commande
→ réponse au client
→ persistance

Le système doit également pouvoir demander une clarification, réviser une action après un résultat d'outil, gérer un échec, escalader vers un humain et planifier une relance persistante.

---

## 2. Principes d'architecture

### 2.1 Le LLM interprète, les outils agissent

Toute information opérationnelle passe par un outil typé : produit, stock, prix, promotion, livraison, panier, commande et mémoire.

### 2.2 Le code déterministe protège les décisions sensibles

Les règles de disponibilité, prix final, promotions, remises, livraison, mode de paiement et création de commande ne dépendent jamais uniquement du modèle.

### 2.3 PostgreSQL est la source de vérité

Redis sert au cache, à l'état court et aux tâches asynchrones. PostgreSQL conserve la vérité métier durable.

### 2.4 Une erreur visible vaut mieux qu'un résultat inventé

Si une dépendance ou une donnée est indisponible, le workflow s'arrête proprement et produit une clarification, une erreur contrôlée ou une escalade.

---

## 3. Stack technique

### Frontend

- React 18
- TypeScript
- Vite
- WebSocket pour le chat temps réel
- HTTP REST pour le dashboard

### Backend

- Node.js 20+
- TypeScript
- Fastify
- WebSocket
- Zod

### Orchestration

- LangGraph.js

### Données

- PostgreSQL 16
- Redis 7
- BullMQ

### Exécution

- Docker
- Docker Compose

### Modèles

- modèle rapide pour extraction, classification, langue, reformulation et JSON structuré ;
- modèle de raisonnement pour planification multi-étapes et révision de plan.

---

## 4. Services Docker

Le projet utilise cinq services :

1. `web`
2. `api`
3. `worker`
4. `postgres`
5. `redis`

Architecture :

```text
Navigateur
   |
   v
Web React
   |
   | WebSocket / HTTP
   v
API Fastify
   |
   +---- LangGraph
   |       |
   |       +---- LLM
   |       +---- Outils métier
   |
   +---- PostgreSQL
   |
   +---- Redis
            |
            v
          BullMQ
            |
            v
          Worker
```

---

## 5. Structure prévisionnelle

```text
m3ak/
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/
├── packages/
│   └── shared/
├── data/
│   └── raw/
├── docs/
├── tests/
├── spec.md
├── design.md
├── tasks.md
├── CLAUDE.md
├── README.md
├── docker-compose.yml
├── .env.example
├── .gitignore
└── package.json
```

Pas de microservices supplémentaires pour le MVP.

---

## 6. État principal LangGraph

L'état partagé `M3AKState` contient notamment :

### Identité

- `threadId`
- `conversationId`
- `customerId`

### Conversation

- messages récents ;
- résumé utile ;
- langue détectée ;
- intention actuelle.

### Extraction

- produit ;
- famille ;
- couleur ;
- taille ;
- quantité ;
- ville ;
- adresse ;
- mode de paiement ;
- confirmation.

### Panier

- articles ;
- quantités ;
- prix validés ;
- promotion ;
- livraison ;
- total.

### Planification

- action suivante ;
- plan actif ;
- étapes exécutées ;
- nombre d'itérations.

### Outils

- résultats ;
- erreurs.

### Garde-fous

- autorisé ;
- clarification nécessaire ;
- intervention humaine nécessaire ;
- raisons.

### Résultat

- `orderId`
- `escalationId`
- `followupId`

---

## 7. Graphe principal

```text
START
  |
  v
loadContext
  |
  v
conversationAgent
  |
  v
complexityRouter
  |
  +----------------------+
  |                      |
simple                 complexe
  |                      |
  v                      v
deterministicRouter   orchestratorAgent
  |                      |
  +----------+-----------+
             |
             v
        actionRouter
             |
     +-------+--------+---------+---------+
     |                |         |         |
     v                v         v         v
 catalogue          panier   livraison   mémoire
     |                |         |         |
     +----------------+---------+---------+
                      |
                      v
                  guardrail
                      |
          +-----------+-----------+
          |                       |
          v                       v
        valide                  refus
          |                       |
          v                       v
   besoin autre action       escalation
          |
     oui / non
      |      |
      v      v
   revise   responseAgent
      |          |
      +----------+
           |
           v
      persistState
           |
           v
          END
```

Une limite stricte empêche toute boucle infinie.

---

## 8. Conversation Agent

Mission :

- détecter la langue ;
- identifier l'intention ;
- extraire les préférences ;
- déterminer les informations manquantes.

Le résultat est structuré et validé par Zod avant d'entrer dans le graphe.

Exemple :

```json
{
  "language": "darija",
  "intent": "product_search",
  "productQuery": "veste",
  "color": "noir",
  "size": "M",
  "quantity": 1,
  "city": null,
  "orderConfirmation": "unknown",
  "confidence": 0.91
}
```

---

## 9. Gestion des langues

Valeurs principales :

- `darija`
- `arabe`
- `français`
- `mixte`
- `inconnu`

M3AK répond dans le registre du client lorsque cela est possible.

---

## 10. Orchestrateur

L'Orchestrateur décide des actions nécessaires pour les demandes complexes.

Il ne modifie jamais directement la base, le panier, le stock, le prix ou la commande.

Il produit uniquement un plan composé d'actions autorisées.

Exemple :

```json
[
  {
    "action": "SEARCH_PRODUCTS",
    "reason": "Identifier les variantes correspondant à la demande"
  },
  {
    "action": "CHECK_STOCK",
    "reason": "Vérifier la disponibilité réelle"
  }
]
```

Le modèle ne peut pas inventer un outil arbitraire.

---

## 11. Outils catalogue

Outils prévus :

- `searchProducts`
- `getProduct`
- `getAvailability`
- `findAlternatives`
- `getApplicablePromotion`

Les résultats viennent de PostgreSQL.

Une alternative doit réellement exister, être disponible et rester pertinente.

---

## 12. Remises et promotions

Les promotions sont déterminées à partir des données réelles.

Une fonction déterministe `validateDiscount()` applique les limites de la politique commerciale.

Le LLM ne peut jamais contourner cette fonction.

---

## 13. Livraison

`getDeliveryOptions(city)` retourne notamment :

- ville couverte ;
- frais ;
- délai ;
- paiement à la livraison ;
- retrait éventuel.

Si la ville n'est pas connue, M3AK demande clarification ou escalade. Aucun délai ou frais n'est inventé.

---

## 14. Panier

Outils :

- `createCart`
- `getCart`
- `addCartItem`
- `updateCartItem`
- `removeCartItem`
- `calculateCartTotal`

Les calculs sont déterministes.

Un changement de taille ou de couleur met à jour le panier existant.

---

## 15. Création de commande

Une commande n'est créée que si :

- le client confirme explicitement ;
- chaque référence existe ;
- le stock est suffisant ;
- la livraison est connue ;
- le mode de paiement est autorisé ;
- aucun blocage critique n'est actif.

La création utilise une transaction PostgreSQL et doit être idempotente.

---

## 16. Garde-fous

Le garde-fou vérifie notamment :

- prix issu d'une vraie référence ;
- stock suffisant ;
- promotion valide ;
- remise autorisée ;
- ville connue ;
- paiement autorisé ;
- absence de promesse de réassort inventée ;
- conditions d'escalade.

---

## 17. Escalade humaine

Lorsqu'une intervention humaine est nécessaire :

1. création d'une escalade en PostgreSQL ;
2. sauvegarde du motif ;
3. sauvegarde d'un résumé du contexte ;
4. apparition dans le dashboard ;
5. réponse contrôlée au client.

---

## 18. Mémoire

Trois niveaux :

### Niveau 1 — tour courant

Contexte immédiat.

### Niveau 2 — conversation active

Panier, préférences, informations déjà demandées, intention en cours.

### Niveau 3 — mémoire durable

PostgreSQL conserve client, commandes, conversations, informations validées et checkpoints.

Lors d'un retour client, seul le contexte pertinent est récupéré.

---

## 19. Checkpoints LangGraph

Chaque conversation possède un `thread_id`.

Les checkpoints doivent permettre de restaurer l'état après redémarrage. Une mémoire uniquement en RAM n'est pas acceptable.

---

## 20. Redis et BullMQ

Redis n'est pas la source de vérité métier.

BullMQ gère les tâches différées, notamment les relances.

Une relance ne doit jamais utiliser `setTimeout` comme mécanisme principal.

---

## 21. Relance autonome

Workflow :

```text
conversation inactive
→ éligibilité à la relance
→ job BullMQ
→ délai
→ worker
→ revérification du contexte
→ génération du message
→ enregistrement
→ émission vers le simulateur
```

Avant envoi, le worker revérifie qu'aucune commande n'a été créée et que le contexte reste valable.

---

## 22. Tables principales

Tables prévues :

- `customers`
- `products`
- `promotions`
- `delivery_zones`
- `conversations`
- `messages`
- `carts`
- `cart_items`
- `orders`
- `order_items`
- `escalations`
- `followups`
- `agent_events`

---

## 23. Journal agentique

`agent_events` enregistre des événements lisibles :

- `node_started`
- `intent_detected`
- `tool_called`
- `tool_succeeded`
- `tool_failed`
- `guardrail_blocked`
- `clarification_requested`
- `escalation_created`
- `order_created`
- `followup_scheduled`

Ce journal ne contient jamais de chaîne de pensée privée du modèle.

---

## 24. API

Routes minimales :

```text
GET  /health
GET  /api/dashboard
GET  /api/conversations
GET  /api/conversations/:id
GET  /api/orders
GET  /api/escalations
POST /api/escalations/:id/resolve
```

WebSocket :

```text
/ws/chat
```

---

## 25. WebSocket

Le serveur peut émettre :

- `agent.status`
- `agent.tool`
- `agent.guardrail`
- `agent.message`
- `agent.error`

Le frontend montre ainsi de vraies actions de l'agent sans exposer de raisonnement privé.

---

## 26. Dashboard

Le dashboard montre au minimum :

- conversations ;
- commandes ;
- conversion ;
- escalades ;
- relances.

Les métriques viennent de PostgreSQL.

---

## 27. Gestion des erreurs

### LLM indisponible

Erreur contrôlée, aucune réponse commerciale inventée.

### PostgreSQL indisponible

Aucune commande créée ou simulée.

### Redis indisponible

Aucune fausse confirmation de relance planifiée.

### Erreur outil

L'Orchestrateur peut retenter une fois si l'erreur est transitoire, demander clarification, escalader ou arrêter.

---

## 28. Validation Zod

Zod valide :

- messages WebSocket ;
- payloads HTTP ;
- sorties structurées LLM ;
- plans de l'Orchestrateur ;
- arguments d'outils ;
- résultats critiques.

Une sortie LLM invalide n'est jamais utilisée directement.

---

## 29. Secrets

`.env` reste local et gitignoré.

`.env.example` contient uniquement les noms des variables attendues.

Aucune clé réelle ne doit apparaître dans le dépôt, les logs ou le navigateur.

---

## 30. RAG

Aucun RAG n'est requis pour le MVP initial.

Les données critiques sont structurées. Un RAG éventuel pour la FAQ ou la politique commerciale ne pourra être ajouté qu'après validation du cœur EX-01 à EX-08.

---

## 31. WhatsApp

WhatsApp Cloud API n'appartient pas au chemin critique.

Le simulateur Web est le canal principal du MVP.

---

## 32. Tests attendus

### Unitaires

- promotions ;
- remises ;
- livraison ;
- disponibilité ;
- panier ;
- total ;
- règles d'escalade.

### Intégration

- PostgreSQL ;
- outils catalogue ;
- création commande ;
- mémoire ;
- BullMQ.

### Agentiques

- rupture de stock ;
- changement d'avis ;
- remise ;
- ville hors grille ;
- hors domaine ;
- darija ;
- retour client.

### End-to-end

message
→ graphe
→ outils
→ base
→ réponse
→ dashboard

---

## 33. Critère de validation de l'architecture

L'architecture est validée lorsque nous pouvons prouver :

- orchestration LangGraph réelle ;
- outils métier réels ;
- état conversationnel ;
- mémoire persistante ;
- commande réellement créée ;
- garde-fous déterministes ;
- escalade réelle ;
- relance BullMQ réelle ;
- dashboard alimenté par PostgreSQL ;
- Docker reproductible ;
- fonctionnement darija/arabe/français ;
- absence d'information commerciale inventée.
