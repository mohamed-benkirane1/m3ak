# CLAUDE.md — M3AK

## 1. Rôle de Claude Code

Tu travailles sur **M3AK**, projet du hackathon ESISA × Numeos Technology 2026.

Sujet officiel : **Sujet 02 — Kenza**
Nom du produit : **M3AK**

M3AK est un agent commercial conversationnel destiné aux commerçants marocains. Il comprend et répond en darija, arabe et français.

Tu es un **agent d'implémentation**. Tu n'es pas le Product Owner ni l'architecte principal.

Les décisions produit et architecture sont définies dans :

- `spec.md`
- `design.md`
- `tasks.md`

---

## 2. Sources de vérité

Ordre de priorité :

1. `spec.md`
2. `design.md`
3. tâche courante fournie par le Control Center
4. `tasks.md`
5. `CLAUDE.md`
6. cahier officiel Kenza
7. dataset officiel

En cas de contradiction importante : arrêter et la signaler. Ne pas choisir arbitrairement.

---

## 3. Règle fondamentale

Une tâche à la fois.

Avant modification :

1. lire la tâche ;
2. lire les fichiers concernés ;
3. vérifier `git status` ;
4. inspecter les dépendances directes ;
5. modifier uniquement ce qui est demandé ;
6. exécuter les validations ;
7. retourner un rapport précis.

---

## 4. Interdiction absolue de commit

Claude Code ne doit jamais :

- exécuter `git commit` ;
- exécuter `git push` ;
- créer un tag ;
- modifier `user.name` ou `user.email` ;
- ajouter `Co-authored-by`;
- modifier l'auteur Git ;
- réécrire l'historique.

À la fin d'une tâche, retourner uniquement les informations nécessaires au responsable humain.

---

## 5. Git

Avant toute tâche :

```bash
git status
```

À la fin :

```bash
git status
git diff --stat
git diff
```

Ne jamais exécuter sans autorisation explicite :

```bash
git reset --hard
git clean -fd
git checkout -- .
git restore .
```

Ne jamais écraser silencieusement une modification préexistante.

---

## 6. Stack

### Frontend

- React 18
- TypeScript
- Vite

### Backend

- Node.js 20+
- TypeScript
- Fastify
- WebSocket

### Agent

- `@langchain/langgraph`

### Données

- PostgreSQL 16
- Redis 7
- BullMQ

### Validation

- Zod

### Exécution

- Docker
- Docker Compose

Ne pas changer de stack sans instruction explicite.

---

## 7. Modèles

Deux catégories :

### Modèle rapide

Pour :

- extraction ;
- classification ;
- détection de langue ;
- compréhension simple ;
- reformulation ;
- JSON structuré ;
- réponse conversationnelle simple.

### Modèle de raisonnement

Uniquement pour :

- planification multi-étapes ;
- orchestration complexe ;
- révision de plan ;
- décision nécessitant plusieurs observations.

Ne pas utiliser systématiquement le modèle de raisonnement.

---

## 8. Variables d'environnement

Les vraies valeurs vivent uniquement dans `.env`.

`.env` doit rester gitignoré.

`.env.example` contient uniquement les noms des variables.

Ne jamais :

- écrire une vraie clé dans le code ;
- écrire une vraie clé dans un test ;
- écrire une vraie clé dans README ;
- afficher une clé dans les logs ;
- retourner une clé dans une API ;
- envoyer une clé au navigateur.

Si un secret apparaît dans un fichier versionné : arrêter et le signaler.

---

## 9. Frontière LLM / code

### Le LLM peut

- comprendre darija, arabe et français ;
- extraire une intention ;
- extraire des préférences ;
- choisir un outil autorisé ;
- expliquer un résultat ;
- rédiger une réponse ;
- demander clarification ;
- proposer une formulation de relance.

### Le LLM ne doit jamais décider seul

- prix ;
- stock ;
- frais ou délai de livraison ;
- promotion ;
- remise autorisée ;
- validité d'un mode de paiement ;
- création définitive d'une commande ;
- identité réelle d'un client ;
- historique absent.

Ces éléments passent par PostgreSQL, les outils métier et les fonctions déterministes.

---

## 10. Zéro hallucination métier

Si une donnée n'existe pas : ne pas l'inventer.

Exemples interdits :

- prix supposé ;
- stock supposé ;
- réapprovisionnement inventé ;
- ville de livraison imaginée ;
- promotion inventée ;
- historique client inventé.

Réponses autorisées :

- clarification ;
- indisponibilité explicite ;
- escalade humaine.

---

## 11. Sources métier

Pour les informations actuelles :

1. PostgreSQL
2. catalogue et stock
3. promotions
4. livraison
5. politique commerciale
6. FAQ
7. mémoire client validée

Les conversations historiques servent au langage et aux intentions, pas aux prix ou stocks actuels.

---

## 12. Langues

Obligatoires :

- darija ;
- arabe ;
- français.

L'anglais n'est pas une exigence du MVP.

En cas de mélange darija/français, conserver un registre naturel proche de celui du client.

---

## 13. Validation Zod

Toute donnée non fiable doit être validée :

- HTTP ;
- WebSocket ;
- sortie structurée LLM ;
- plan de l'Orchestrateur ;
- arguments d'outils ;
- résultats critiques.

Ne jamais utiliser directement un `JSON.parse()` de sortie LLM sans validation.

---

## 14. Outils métier

Les actions métier doivent être explicites, typées et testables.

Exemples :

- `searchProducts`
- `getProduct`
- `getAvailability`
- `findAlternatives`
- `getApplicablePromotion`
- `validateDiscount`
- `getDeliveryOptions`
- `createCart`
- `getCart`
- `addCartItem`
- `updateCartItem`
- `removeCartItem`
- `calculateCartTotal`
- `createOrder`
- `getCustomerMemory`
- `createEscalation`
- `scheduleFollowup`

---

## 15. LangGraph

LangGraph doit être utilisé dans le chemin production.

Le graphe doit :

- posséder un état typé ;
- contenir des responsabilités distinctes ;
- appeler de vrais outils ;
- utiliser un routage explicite ;
- gérer les erreurs ;
- gérer l'escalade ;
- pouvoir reprendre son état.

Une API qui contourne le graphe pour appeler directement un LLM n'est pas conforme.

---

## 16. Boucles agentiques

Toute boucle possède une limite stricte via `MAX_AGENT_STEPS`.

Lorsque la limite est atteinte :

- arrêter ;
- enregistrer l'état ;
- produire une erreur contrôlée ou une escalade.

---

## 17. Raisonnement observable

Le produit peut exposer des événements métier :

- langue détectée ;
- recherche catalogue ;
- stock vérifié ;
- livraison calculée ;
- garde-fou appliqué ;
- confirmation requise ;
- commande créée.

Ne jamais exposer :

- chaîne de pensée privée ;
- tokens internes ;
- prompts système secrets.

---

## 18. PostgreSQL

PostgreSQL est la source de vérité durable.

Utiliser :

- clés primaires ;
- clés étrangères ;
- contraintes ;
- transactions lorsque nécessaire ;
- timestamps ;
- indexes raisonnables.

Ne pas mettre toute la logique métier dans les handlers HTTP.

---

## 19. Commandes

Avant création :

- confirmation explicite ;
- produit valide ;
- quantité valide ;
- stock suffisant ;
- livraison valide ;
- paiement valide ;
- aucun blocage actif.

Utiliser une transaction.

En cas d'erreur : rollback.

Aucune commande partielle ne doit rester.

---

## 20. Idempotence

Une même confirmation ne doit jamais créer plusieurs commandes.

Résister au :

- double clic ;
- message répété ;
- retry réseau ;
- retry du graphe.

Tester explicitement.

---

## 21. Redis et BullMQ

Redis n'est pas la source de vérité métier.

BullMQ sert aux tâches persistantes comme les relances.

`setTimeout(...)` est interdit comme mécanisme principal de relance.

Les jobs doivent avoir retries limités, backoff, état et gestion explicite de l'échec.

---

## 22. Relances

Avant d'envoyer une relance, revérifier :

- conversation toujours inactive ;
- aucune commande finalisée ;
- contexte toujours pertinent ;
- client toujours éligible.

Ne jamais envoyer une relance uniquement parce qu'un ancien job existe.

---

## 23. Dataset

Les fichiers bruts officiels doivent être conservés séparément, idéalement sous `data/raw/`.

Ne pas modifier silencieusement les sources.

Les imports doivent être reproductibles, idempotents et vérifiables.

---

## 24. Frontend

Priorités :

1. fonctionnement ;
2. lisibilité ;
3. feedback utilisateur ;
4. visibilité de l'activité agentique ;
5. esthétique.

Ne pas sacrifier une fonction métier pour des animations.

---

## 25. Dashboard

Les métriques doivent provenir de vraies données.

Aucune valeur statique présentée comme réelle.

---

## 26. Mocks

Autorisés dans les tests lorsque pertinent.

Interdits dans le chemin production pour simuler :

- stock ;
- commande ;
- réponse agentique ;
- événements ;
- dashboard ;
- relance.

---

## 27. Tests

Selon la tâche, exécuter les commandes pertinentes, par exemple :

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Une fonctionnalité n'est pas terminée uniquement parce qu'elle compile.

---

## 28. Gestion des erreurs

Ne jamais convertir une erreur réelle en faux succès.

Un échec doit être remonté, typé, journalisé correctement et traité explicitement.

---

## 29. Logs

Ils peuvent contenir :

- identifiant conversation ;
- identifiant job ;
- outil appelé ;
- durée ;
- statut ;
- catégorie d'erreur.

Ils ne doivent pas contenir :

- secrets ;
- clés API ;
- données sensibles inutiles ;
- chaîne de pensée privée.

---

## 30. Sécurité

Vérifier notamment :

- entrées validées ;
- aucun secret frontend ;
- requêtes DB paramétrées ;
- erreurs contrôlées ;
- tailles de payload raisonnables ;
- WebSocket validé ;
- aucun état interne privilégié accepté depuis le navigateur.

---

## 31. Documentation et nommage

Documentation produit : français.

Noms techniques : anglais.

Exemples :

```ts
createOrder()
getDeliveryOptions()
validateDiscount()
```

---

## 32. Qualité du code

Préférer :

- petites fonctions ;
- responsabilités claires ;
- typage strict ;
- noms explicites ;
- erreurs typées ;
- logique testable.

Éviter :

- abstraction prématurée ;
- architecture inutilement complexe ;
- fichiers géants ;
- duplication importante.

---

## 33. Ne pas sur-architecturer

Ne pas ajouter sans instruction :

- microservices supplémentaires ;
- Kubernetes ;
- Kafka ;
- RabbitMQ ;
- GraphQL ;
- Elasticsearch ;
- vector database externe ;
- blockchain ;
- framework supplémentaire.

---

## 34. RAG

Le RAG n'est pas requis pour le MVP initial.

Ne pas ajouter pgvector, embeddings ou pipeline RAG sans tâche explicitement approuvée.

---

## 35. WhatsApp et bonus

Ne pas commencer automatiquement :

- WhatsApp réel ;
- notes vocales ;
- vision ;
- A/B testing ;
- analytics avancées.

Le cœur EX-01 à EX-08 doit être validé d'abord.

---

## 36. Fichiers hors périmètre

Respecter la liste de fichiers autorisés par la tâche.

Si un fichier supplémentaire semble nécessaire, l'expliquer avant de l'étendre au périmètre sauf si la tâche autorise explicitement les dépendances directes.

---

## 37. Rapport obligatoire de fin de tâche

Toujours retourner :

### 1. Résumé

Ce qui a réellement été implémenté.

### 2. Fichiers modifiés

Liste exacte.

### 3. Fichiers créés

Liste exacte.

### 4. Vérifications exécutées

Pour chaque commande :

- commande ;
- exit code ;
- résultat.

### 5. Tests

- exécutés ;
- réussis ;
- échoués.

### 6. Limitations ou problèmes

Si aucun :

`Aucun problème connu dans le périmètre de cette tâche.`

### 7. Git diff --stat

Retour réel.

### 8. Git status

Retour réel.

### 9. Commit suggéré

Message uniquement.

**Ne pas créer le commit.**

---

## 38. Définition de DONE

Une tâche n'est DONE que si :

- l'objectif est réellement implémenté ;
- le code compile dans son périmètre ;
- les tests concernés passent ;
- aucune erreur connue n'est masquée ;
- le diff reste dans le périmètre ;
- aucun secret n'est présent ;
- le rapport est complet.

Sinon : `PARTIAL` ou `BLOCKED`.

---

## 39. Priorité générale

En cas de manque de temps :

1. fonctionnement end-to-end ;
2. exactitude métier ;
3. garde-fous ;
4. tests ;
5. reproductibilité ;
6. dashboard ;
7. UX ;
8. bonus.

Toujours préférer une fonctionnalité plus petite et fiable à une fonctionnalité spectaculaire mais fragile.

---

## 40. Rappel final

Chaque fonctionnalité doit répondre à trois questions :

1. Pourquoi existe-t-elle ?
2. Comment fonctionne-t-elle réellement ?
3. Quelle preuve montre qu'elle fonctionne ?

Si la troisième réponse n'existe pas, la fonctionnalité n'est pas terminée.
