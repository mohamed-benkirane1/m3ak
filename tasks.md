# M3AK — Plan d'exécution

**Hackathon :** ESISA × Numeos Technology 2026
**Sujet officiel :** Sujet 02 — Kenza
**Produit :** M3AK
**Version :** 0.1

---

## 1. Règle de travail

Chaque tâche suit :

1. ChatGPT définit la tâche.
2. Claude Code implémente uniquement cette tâche.
3. Claude Code exécute les vérifications demandées.
4. Claude Code retourne fichiers modifiés, tests, `git diff` et `git status`.
5. ChatGPT audite.
6. Mohamed crée le commit manuellement.
7. Passage à la tâche suivante.

Claude Code ne doit jamais :

- créer un commit ;
- pousser sur GitHub ;
- ajouter `Co-authored-by`;
- modifier des fichiers hors périmètre sans justification.

Principe :

```text
ONE TASK
→ IMPLEMENT
→ TEST
→ REVIEW
→ MANUAL COMMIT
→ NEXT
```

---

## 2. Priorités

- **CRITICAL** : nécessaire au MVP et à la soumission.
- **IMPORTANT** : améliore directement fiabilité ou démonstration.
- **OPTIONAL** : bonus après stabilisation.
- **CUT** : ne pas développer pendant le hackathon sauf décision explicite.

---

## 3. Phase A — Fondation

### TASK-001 — Initialiser la structure du dépôt

**Priorité : CRITICAL**

Créer notamment :

- `apps/web`
- `apps/api`
- `apps/worker`
- `packages/shared`
- `data/raw`
- `docs`

Ajouter la configuration workspace et TypeScript.

Validation :

- installation des dépendances ;
- TypeScript opérationnel ;
- `.env` ignoré ;
- structure claire.

Commit suggéré :

`chore: initialize m3ak project structure`

### TASK-002 — Docker de base

**Priorité : CRITICAL**

Créer les services :

- web
- api
- worker
- postgres
- redis

Validation :

`docker compose config`

Commit :

`chore: add docker development environment`

### TASK-003 — Healthchecks

**Priorité : CRITICAL**

`GET /health` doit vérifier l'API, PostgreSQL et Redis.

Pas de statut statique trompeur.

Commit :

`feat: add infrastructure health checks`

---

## 4. Phase B — Données

### TASK-004 — Contrats partagés

**Priorité : CRITICAL**

Créer les schémas Zod et types pour :

- Language
- Customer
- Product
- Promotion
- DeliveryZone
- Conversation
- Message
- Cart
- CartItem
- Order
- OrderItem
- Escalation
- Followup

Commit :

`feat: define shared domain contracts`

### TASK-005 — Schéma PostgreSQL

**Priorité : CRITICAL**

Créer au minimum :

- customers
- products
- promotions
- delivery_zones
- conversations
- messages
- carts
- cart_items
- orders
- order_items
- escalations
- followups
- agent_events

Commit :

`feat: add core database schema`

### TASK-006 — Import dataset Kenza

**Priorité : CRITICAL**

Importer les données officielles utiles :

- catalogue
- clients
- commandes
- lignes de commande
- promotions
- livraison

L'import doit être reproductible et idempotent.

Commit :

`feat: add idempotent kenza dataset seed`

---

## 5. Phase C — Outils métier

### TASK-007 — Catalogue et stock

**Priorité : CRITICAL**

Implémenter :

- `searchProducts`
- `getProduct`
- `getAvailability`

Commit :

`feat: add catalogue and stock tools`

### TASK-008 — Alternatives

**Priorité : IMPORTANT**

Implémenter `findAlternatives`.

Une alternative doit exister, être en stock et rester pertinente.

Commit :

`feat: add stock-aware product alternatives`

### TASK-009 — Promotions et remises

**Priorité : CRITICAL**

Implémenter :

- `getApplicablePromotion`
- `validateDiscount`

Commit :

`feat: enforce promotion and discount rules`

### TASK-010 — Livraison

**Priorité : CRITICAL**

Implémenter `getDeliveryOptions`.

Une ville inconnue doit produire clarification ou escalade.

Commit :

`feat: add deterministic delivery lookup`

---

## 6. Phase D — Panier et commande

### TASK-011 — Panier persistant

**Priorité : CRITICAL**

Implémenter :

- `createCart`
- `getCart`
- `addCartItem`
- `updateCartItem`
- `removeCartItem`
- `calculateCartTotal`

Commit :

`feat: implement persistent shopping cart`

### TASK-012 — Commande transactionnelle

**Priorité : CRITICAL**

Créer `createOrder` avec :

- confirmation ;
- stock ;
- livraison ;
- paiement ;
- transaction PostgreSQL ;
- rollback en cas d'erreur.

Commit :

`feat: add transactional order creation`

### TASK-013 — Idempotence commande

**Priorité : IMPORTANT**

Deux confirmations identiques ne doivent jamais créer deux commandes.

Commit :

`fix: prevent duplicate order creation`

---

## 7. Phase E — Infrastructure LLM

### TASK-014 — Client modèle rapide

**Priorité : CRITICAL**

Client configurable par environnement pour :

- extraction ;
- classification ;
- langue ;
- génération simple.

Commit :

`feat: add fast llm client`

### TASK-015 — Client modèle de raisonnement

**Priorité : CRITICAL**

Client séparé, utilisé uniquement lorsque la situation est réellement complexe.

Commit :

`feat: add reasoning llm client`

### TASK-016 — Extraction structurée

**Priorité : CRITICAL**

Transformer un message naturel en objet Zod validé.

Tester français, arabe, darija, mixte et messages incomplets.

Commit :

`feat: add structured conversation extraction`

---

## 8. Phase F — LangGraph

### TASK-017 — Définir M3AKState

**Priorité : CRITICAL**

État typé, sérialisable et compatible LangGraph.

Commit :

`feat: define m3ak agent state`

### TASK-018 — Premier graphe de vente

**Priorité : CRITICAL**

Premier parcours :

```text
START
→ loadContext
→ conversation
→ router
→ tool
→ guardrail
→ response
→ persist
→ END
```

Commit :

`feat: add initial langgraph sales workflow`

### TASK-019 — Orchestrateur complexe

**Priorité : CRITICAL**

Plan multi-étapes limité à une liste d'actions autorisées.

Commit :

`feat: add multi-step sales orchestration`

### TASK-020 — Boucle de révision bornée

**Priorité : IMPORTANT**

Permettre outil → observation → révision → nouvel outil avec `MAX_AGENT_STEPS`.

Commit :

`feat: add bounded agent revision loop`

---

## 9. Phase G — Garde-fous et escalade

### TASK-021 — Garde-fous commerciaux

**Priorité : CRITICAL**

Bloquer notamment :

- prix inventé ;
- stock inventé ;
- promotion inventée ;
- remise interdite ;
- livraison inventée ;
- faux réassort.

Commit :

`feat: enforce deterministic sales guardrails`

### TASK-022 — Escalade humaine

**Priorité : CRITICAL**

Créer et persister :

- motif ;
- résumé contexte ;
- statut.

Commit :

`feat: add human escalation workflow`

---

## 10. Phase H — Mémoire

### TASK-023 — Persistance conversationnelle

**Priorité : CRITICAL**

Persister conversation, messages, langue, panier et informations utiles.

Commit :

`feat: persist conversation state`

### TASK-024 — Checkpoints LangGraph PostgreSQL

**Priorité : CRITICAL**

Même `thread_id` après reprise → état restauré.

Commit :

`feat: persist langgraph checkpoints`

### TASK-025 — Mémoire client longue durée

**Priorité : CRITICAL**

Un client qui revient ne doit pas tout répéter.

Commit :

`feat: add persistent customer memory`

---

## 11. Phase I — Relance autonome

### TASK-026 — BullMQ

**Priorité : CRITICAL**

Créer queue et worker.

Commit :

`feat: add background job infrastructure`

### TASK-027 — Planification relance

**Priorité : CRITICAL**

Définir l'éligibilité et créer un job persistant.

Commit :

`feat: schedule abandoned conversation followups`

### TASK-028 — Exécution relance

**Priorité : CRITICAL**

Avant exécution, revérifier conversation, commande, client et contexte.

Commit :

`feat: execute contextual sales followups`

---

## 12. Phase J — Temps réel

### TASK-029 — WebSocket chat

**Priorité : CRITICAL**

Créer `/ws/chat`.

Commit :

`feat: add realtime chat websocket`

### TASK-030 — Événements agentiques publics

**Priorité : IMPORTANT**

Émettre des événements lisibles sans chaîne de pensée privée.

Commit :

`feat: expose auditable agent activity events`

---

## 13. Phase K — Frontend

### TASK-031 — Simulateur de chat

**Priorité : CRITICAL**

Permettre :

- sélectionner/créer client ;
- envoyer message ;
- recevoir réponse ;
- voir chargement et erreurs ;
- conserver conversation.

Commit :

`feat: add customer chat simulator`

### TASK-032 — Activité agentique

**Priorité : IMPORTANT**

Afficher uniquement de vrais événements.

Commit :

`feat: visualize agent workflow activity`

### TASK-033 — Dashboard commerçant

**Priorité : CRITICAL**

Afficher :

- conversations ;
- commandes ;
- conversion ;
- escalations ;
- relances.

Commit :

`feat: add merchant dashboard`

---

## 14. Phase L — Scénarios obligatoires

### TASK-034 — Rupture de stock

`test: cover out-of-stock sales flow`

### TASK-035 — Changement d'avis

`test: cover customer change-of-mind flow`

### TASK-036 — Négociation

`test: cover discount negotiation guardrails`

### TASK-037 — Darija

`test: cover darija conversation scenarios`

### TASK-038 — Hors domaine

`test: cover out-of-domain escalation`

### TASK-039 — Mémoire client

`test: verify persistent customer memory`

### TASK-040 — Relance

`test: verify autonomous followup workflow`

Toutes ces tâches sont **CRITICAL**.

---

## 15. Phase M — Fiabilité

### TASK-041 — Panne LLM

**Priorité : IMPORTANT**

`test: handle llm provider failure`

### TASK-042 — Panne PostgreSQL

**Priorité : IMPORTANT**

`test: handle database failure safely`

### TASK-043 — Panne Redis

**Priorité : IMPORTANT**

`test: handle redis failure safely`

### TASK-044 — Audit secrets

**Priorité : CRITICAL**

Vérifier :

- `.env` absent de Git ;
- aucune clé dans la source ;
- aucun secret dans les logs ;
- `.env.example` propre.

Commit si nécessaire :

`chore: harden secret handling`

---

## 16. Phase N — Reproductibilité

### TASK-045 — Docker complet

**Priorité : CRITICAL**

`docker compose up --build`

doit produire une application utilisable.

Commit :

`chore: finalize reproducible docker startup`

### TASK-046 — README final

**Priorité : CRITICAL**

Documenter problème, architecture, agents, outils, stack, installation, variables, Docker, tests, limites et scénario de démonstration.

Commit :

`docs: complete project documentation`

---

## 17. Phase O — Audit final

### TASK-047 — Audit complet en lecture seule

**Priorité : CRITICAL**

Audit source + runtime + Docker + DB + LangGraph + outils + garde-fous + mémoire + relances + UI + tests + secrets.

Aucun commit.

### TASK-048 — Corrections critiques

**Priorité : CRITICAL**

Chaque défaut important devient sa propre sous-tâche. Aucun mega-fix.

---

## 18. Bonus

Seulement après validation du cœur :

- TASK-B01 — notes vocales ;
- TASK-B02 — reconnaissance image produit ;
- TASK-B03 — négociation avancée ;
- TASK-B04 — A/B testing relances ;
- TASK-B05 — WhatsApp réel.

---

## 19. Éléments explicitement coupés du MVP

Ne pas développer pendant le chemin critique :

- authentification avancée ;
- multi-boutiques ;
- rôles complexes ;
- paiement réel ;
- application mobile ;
- RAG générique ;
- pgvector décoratif ;
- microservices supplémentaires ;
- Kubernetes ;
- analytics avancées ;
- recommandation ML complexe.

---

## 20. Gates de progression

### Gate A — Fondation

TASK-001 à TASK-006 terminées.

### Gate B — Métier

TASK-007 à TASK-013 terminées.

### Gate C — Agent

TASK-014 à TASK-025 terminées.

### Gate D — Autonomie

TASK-026 à TASK-030 terminées.

### Gate E — Produit

TASK-031 à TASK-040 terminées.

### Gate F — Soumission

TASK-041 à TASK-048 nécessaires terminées.

Une gate n'est franchie que lorsqu'elle est réellement testée et vérifiable.
