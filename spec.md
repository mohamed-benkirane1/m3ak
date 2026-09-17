# M3AK — Spécification produit

> Agent commercial conversationnel pour les commerçants marocains.
> De la conversation à la commande — en darija, arabe et français.

**Hackathon :** ESISA × Numeos Technology 2026
**Sujet officiel :** Sujet 02 — Kenza
**Nom du produit :** M3AK
**Version :** 0.1
**Statut :** Spécification MVP

---

## 1. Problème

Au Maroc, une part importante du commerce de détail passe par la messagerie.

Un commerçant peut recevoir chaque jour des centaines de messages concernant les prix, les tailles, les couleurs, les disponibilités, les livraisons ou les commandes. Il ne peut pas répondre instantanément à tout le monde. Pendant ce délai, certains clients abandonnent leur achat ou achètent ailleurs.

Les paniers et conversations abandonnés sont également rarement relancés, non parce qu'ils n'ont aucune valeur commerciale, mais parce que le commerçant manque de temps.

Le problème n'est donc pas simplement de répondre automatiquement aux messages. Le problème est de transformer une conversation naturelle en une vente fiable, sans inventer de prix, de stock, de délai, de promotion ou de règle commerciale.

---

## 2. Utilisateurs

### Utilisateur principal

Le commerçant marocain, ou l'employé chargé de gérer les conversations clients et les commandes.

Il souhaite :

- répondre plus rapidement ;
- convertir davantage de conversations en commandes ;
- réduire les tâches répétitives ;
- récupérer des ventes abandonnées ;
- garder la possibilité de reprendre la main lorsqu'une situation nécessite une décision humaine.

### Utilisateur secondaire

Le client final, qui échange naturellement avec le commerce en :

- darija ;
- arabe ;
- français.

La darija constitue un élément central et différenciant du produit.

---

## 3. Proposition de valeur

M3AK transforme une conversation commerciale en workflow contrôlé :

message client
→ compréhension du besoin
→ consultation des données réelles
→ recommandation
→ gestion du panier
→ calcul de la livraison
→ confirmation
→ création de la commande
→ relance éventuelle
→ escalade humaine si nécessaire

M3AK doit permettre au commerçant d'augmenter sa capacité de traitement sans sacrifier la fiabilité des réponses.

Les indicateurs observables incluent notamment :

- temps moyen de réponse ;
- nombre de commandes créées ;
- taux de conversion ;
- nombre de conversations relancées ;
- taux d'escalade humaine ;
- absence d'informations commerciales inventées.

---

## 4. Principes fondamentaux

### 4.1 Les données métier priment sur le modèle

Le modèle de langage n'est jamais la source de vérité pour :

- les prix ;
- le stock ;
- les variantes ;
- les frais et délais de livraison ;
- les promotions ;
- les limites de remise ;
- les commandes ;
- l'historique client.

Ces informations doivent provenir des outils et des données réelles de l'application.

### 4.2 Le modèle interprète, le code garantit

Le modèle peut comprendre une demande, identifier une intention, extraire des préférences, choisir un outil et rédiger une réponse.

Les contraintes commerciales critiques sont contrôlées par du code déterministe.

### 4.3 En cas de doute, M3AK n'invente pas

Lorsqu'une information est absente, contradictoire ou hors périmètre, M3AK doit :

1. demander une clarification lorsque cela suffit ;
2. ou transférer le dossier au commerçant.

Une réponse prudente vaut mieux qu'une réponse plausible mais fausse.

---

## 5. User stories du MVP

### US-01 — Réaliser une vente par conversation

En tant que client, je veux demander naturellement un produit en darija, en arabe ou en français afin d'obtenir son prix, sa disponibilité et les conditions de livraison puis passer commande sans attendre qu'un vendeur humain soit disponible.

**Priorité : critique**

### US-02 — Gérer correctement les cas commerciaux difficiles

En tant que commerçant, je veux que M3AK gère les ruptures de stock, les changements d'avis, les demandes de remise et les situations hors périmètre afin que l'agent ne fasse jamais une promesse commerciale qu'il n'est pas autorisé à faire.

**Priorité : critique**

### US-03 — Se souvenir du client et récupérer des ventes

En tant que commerçant, je veux que M3AK mémorise les interactions pertinentes avec un client et puisse relancer automatiquement certaines conversations abandonnées afin que le client ne répète pas inutilement les mêmes informations et que les opportunités commerciales ne soient pas perdues.

**Priorité : critique**

---

## 6. Critères d'acceptation

### AC-01 — Vente conversationnelle complète

Étant donné qu'un client contacte le commerce en darija, arabe ou français, quand il souhaite acheter un produit disponible, alors M3AK doit :

- comprendre sa demande ;
- consulter le catalogue avec un outil ;
- consulter le stock réel ;
- récupérer le prix réel ;
- consulter les conditions de livraison ;
- demander uniquement les informations manquantes ;
- obtenir une confirmation explicite ;
- créer réellement la commande dans la base de données.

### AC-02 — Rupture de stock

Si un produit ou une variante a un stock nul, M3AK doit :

- annoncer l'indisponibilité ;
- ne jamais inventer de date de réapprovisionnement ;
- rechercher une alternative réellement disponible ;
- proposer cette alternative lorsqu'elle est pertinente.

### AC-03 — Changement d'avis

Lorsqu'un client change la taille, la couleur, la quantité ou le produit, M3AK doit modifier le panier courant sans recommencer la conversation depuis zéro.

### AC-04 — Demande de remise

M3AK doit :

- consulter la politique commerciale ;
- appliquer uniquement une remise autorisée ;
- ne jamais franchir la limite commerciale déterminée par le système ;
- escalader vers un humain lorsqu'une décision humaine est nécessaire.

Le modèle ne peut pas modifier lui-même les limites commerciales.

### AC-05 — Mémoire client

Lorsqu'un client connu revient, M3AK doit récupérer les informations pertinentes persistées lors des interactions précédentes et éviter de redemander des informations déjà connues et fiables.

### AC-06 — Relance automatique

Lorsqu'une conversation devient une opportunité abandonnée éligible, M3AK doit pouvoir :

- sélectionner la conversation ;
- planifier la relance ;
- produire un message contextualisé ;
- déclencher réellement une tâche de relance persistante.

La relance ne doit pas reposer sur un simple timer en mémoire.

### AC-07 — Escalade humaine

Lorsqu'une demande dépasse le périmètre d'autonomie de M3AK, l'agent doit créer une escalade contenant le contexte utile.

Cela inclut notamment :

- demande commerciale hors politique ;
- information de livraison inconnue ;
- demande hors catalogue ;
- situation nécessitant une décision humaine ;
- question que l'agent ne peut pas traiter de manière fiable.

### AC-08 — Dashboard commerçant

Le dashboard doit afficher à partir de données réelles :

- conversations ;
- commandes ;
- informations de conversion ;
- escalations ;
- état des relances pertinentes.

---

## 7. Responsabilités agentiques

### Conversation

- comprendre le message ;
- conserver le contexte ;
- identifier les informations déjà fournies ;
- déterminer ce qu'il manque.

### Catalogue

- recherche de produits ;
- stock ;
- prix ;
- variantes ;
- promotions ;
- livraison ;
- préparation et création de commande.

### Relance

- identifier les conversations éligibles ;
- décider qu'une relance doit être planifiée ;
- produire un message contextualisé ;
- déclencher la tâche planifiée.

### Garde-fou

- empêcher les prix inventés ;
- empêcher les stocks inventés ;
- empêcher les délais inventés ;
- empêcher les promotions inventées ;
- appliquer les règles commerciales ;
- bloquer les opérations non autorisées.

### Escalade

- détecter les situations nécessitant un humain ;
- conserver le motif ;
- transmettre le contexte ;
- interrompre l'automatisation lorsque nécessaire.

### Orchestrateur

- choisir la prochaine étape ;
- choisir l'outil nécessaire ;
- demander une information manquante ;
- décider de continuer, réessayer, arrêter ou escalader.

---

## 8. Frontière entre LLM et code déterministe

### Le LLM peut

- comprendre le français, l'arabe et la darija ;
- interpréter une formulation ambiguë ;
- extraire les préférences du client ;
- reconnaître l'intention ;
- choisir le prochain outil autorisé ;
- formuler une réponse naturelle ;
- expliquer le résultat d'un outil ;
- produire un message de relance ;
- reconnaître son incertitude.

### Le LLM ne doit pas

- inventer un prix ;
- inventer un stock ;
- inventer une variante ;
- inventer des frais ou délais de livraison ;
- inventer une promotion ;
- inventer une remise ;
- contourner une politique commerciale ;
- créer arbitrairement une commande ;
- inventer un historique client.

### Le code et les outils doivent

- lire le catalogue ;
- consulter le stock ;
- lire les promotions ;
- consulter les règles de livraison ;
- appliquer les règles commerciales ;
- gérer le panier ;
- créer la commande ;
- persister l'état de la conversation ;
- récupérer la mémoire client ;
- créer les escalades ;
- calculer les indicateurs du dashboard.

---

## 9. Sources de vérité

Ordre de confiance pour les informations opérationnelles :

1. base de données applicative ;
2. catalogue et stock actuels ;
3. promotions applicables ;
4. grille de livraison ;
5. politique commerciale ;
6. FAQ boutique ;
7. état client et historique persistant validé.

Les conversations historiques servent à comprendre le vocabulaire, les formulations, la darija et les intentions. Elles ne remplacent pas les sources opérationnelles actuelles.

---

## 10. Gestion des langues

M3AK doit comprendre et répondre en :

- darija ;
- arabe ;
- français.

Lorsque la langue du client est identifiable, M3AK répond dans la même langue.

Lorsque le message mélange plusieurs langues, M3AK privilégie un style naturel proche de celui du client.

L'anglais n'appartient pas au périmètre obligatoire du MVP.

---

## 11. Cas d'échec

M3AK doit traiter explicitement :

- produit inexistant ;
- stock inconnu ;
- ville absente de la grille de livraison ;
- politique commerciale insuffisamment précise ;
- outil indisponible ;
- base de données indisponible ;
- modèle indisponible ;
- message trop ambigu ;
- demande hors périmètre.

Le système doit produire une clarification, une erreur contrôlée ou une escalade humaine. Il ne doit jamais inventer une information pour masquer l'échec.

---

## 12. Hors périmètre du MVP

Sont volontairement exclus du cœur du MVP :

- paiement en ligne réel ;
- gestion multi-boutiques ;
- gestion avancée des rôles ;
- application mobile native ;
- conformité complète aux politiques commerciales Meta ;
- intégration obligatoire à WhatsApp Cloud API.

Le simulateur Web constitue le canal principal du MVP.

Bonus uniquement après stabilisation :

- notes vocales ;
- reconnaissance d'image produit ;
- négociation avancée ;
- A/B testing des relances ;
- WhatsApp réel.

---

## 13. Définition de terminé

Une fonctionnalité n'est pas terminée simplement parce que son code existe.

Elle doit être :

1. implémentée ;
2. testée ;
3. intégrée au vrai workflow ;
4. reliée aux vraies données nécessaires ;
5. vérifiée dans l'application ;
6. démontrable devant le jury.

Le MVP est considéré comme terminé lorsque les exigences obligatoires EX-01 à EX-08 sont démontrables de bout en bout sur des messages non préparés.

---

## 14. Principe de démonstration

Le parcours principal attendu est :

client
→ message naturel
→ compréhension
→ décision de l'orchestrateur
→ appel d'un ou plusieurs outils réels
→ résultat métier
→ mise à jour de la mémoire ou de la base
→ réponse client
→ visibilité côté commerçant

Au moins un cas d'échec ou d'escalade doit également être démontré.
