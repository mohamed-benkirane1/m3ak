import path from "node:path";
import { Client } from "pg";
import {
  mapLanguage,
  parseIsoDate,
  parseMadToCents,
  parseNonNegativeInteger,
  parseOptionalNonNegativeInteger,
  parseOuiNonBoolean,
  readCsvRows,
} from "./parsers";
import {
  RawCatalogueRowSchema,
  RawClientRowSchema,
  RawCommandeRowSchema,
  RawLigneRowSchema,
  RawLivraisonRowSchema,
  RawPromotionRowSchema,
} from "./schemas";

// Resolves from the workspace package directory (apps/api), matching the same
// cwd convention already used by the db:migrate script (`-m db/migrations`).
const DATA_RAW_DIR = path.resolve(process.cwd(), "../../data/raw");

interface ParsedProduct {
  ref: string;
  model: string;
  family: string;
  gender: string;
  color: string;
  size: string;
  material: string;
  season: string;
  priceCents: number;
  stock: number;
  barcode: string;
  weightGrams: number;
  restockDelayDays: number | null;
}

interface ParsedCustomer {
  externalRef: string;
  name: string;
  phone: string;
  city: string;
  preferredLanguage: "french" | "darija" | "arabic";
  importedFirstPurchaseAt: string;
  importedOrderCount: number;
  segment: string;
}

interface ParsedPromotion {
  productRef: string;
  normalPriceCents: number;
  promoPriceCents: number;
  startsAt: string;
  endsAt: string;
  condition: string;
}

interface ParsedDeliveryZone {
  city: string;
  feeCents: number;
  delayHours: number;
  cashOnDelivery: boolean;
  storePickup: boolean;
}

interface ParsedCommande {
  commandeId: string;
  clientExternalRef: string;
  orderDate: string;
  canal: string;
  historicalStatus: string;
  productsTotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  city: string;
  paymentMethod: string;
}

interface ParsedLigne {
  commandeId: string;
  productRef: string;
  model: string;
  size: string;
  quantity: number;
  unitPriceCents: number;
  sourceRowNumber: number;
}

function loadProducts(): ParsedProduct[] {
  const rawRows = readCsvRows(path.join(DATA_RAW_DIR, "catalogue.csv")).map((row) =>
    RawCatalogueRowSchema.parse(row),
  );
  return rawRows.map((row, index) => {
    const context = `catalogue.csv row ${index + 1} (${row.ref})`;
    return {
      ref: row.ref,
      model: row.modele,
      family: row.famille,
      gender: row.genre,
      color: row.couleur,
      size: row.taille,
      material: row.matiere,
      season: row.saison,
      priceCents: parseMadToCents(row.prix_mad, context),
      stock: parseNonNegativeInteger(row.stock, context),
      barcode: row.code_barre,
      weightGrams: parseNonNegativeInteger(row.poids_g, context),
      restockDelayDays: parseOptionalNonNegativeInteger(row.delai_reassort_jours, context),
    };
  });
}

function loadCustomers(): ParsedCustomer[] {
  const rawRows = readCsvRows(path.join(DATA_RAW_DIR, "clients.csv")).map((row) =>
    RawClientRowSchema.parse(row),
  );
  return rawRows.map((row, index) => {
    const context = `clients.csv row ${index + 1} (${row.client_id})`;
    return {
      externalRef: row.client_id,
      name: row.nom,
      phone: row.telephone,
      city: row.ville,
      preferredLanguage: mapLanguage(row.langue_preferee, context),
      importedFirstPurchaseAt: parseIsoDate(row.premier_achat, context),
      importedOrderCount: parseNonNegativeInteger(row.nb_commandes, context),
      segment: row.segment,
    };
  });
}

function loadPromotions(products: ParsedProduct[]): ParsedPromotion[] {
  const modelByRef = new Map(products.map((p) => [p.ref, p.model]));
  const rawRows = readCsvRows(path.join(DATA_RAW_DIR, "promotions.csv")).map((row) =>
    RawPromotionRowSchema.parse(row),
  );
  return rawRows.map((row, index) => {
    const context = `promotions.csv row ${index + 1} (${row.ref})`;
    const catalogueModel = modelByRef.get(row.ref);
    if (catalogueModel === undefined) {
      throw new Error(`${context}: ref does not resolve to any imported product`);
    }
    // The task explicitly requires validating (not storing) this cross-reference:
    // TASK-005 deliberately normalized promotions by product_ref only.
    if (catalogueModel !== row.modele) {
      throw new Error(
        `${context}: modele "${row.modele}" does not match catalogue model "${catalogueModel}" for ref "${row.ref}"`,
      );
    }
    const startsAt = parseIsoDate(row.debut, context);
    const endsAt = parseIsoDate(row.fin, context);
    const normalPriceCents = parseMadToCents(row.prix_normal_mad, context);
    const promoPriceCents = parseMadToCents(row.prix_promo_mad, context);
    if (promoPriceCents > normalPriceCents) {
      throw new Error(
        `${context}: promo_price_cents (${promoPriceCents}) exceeds normal_price_cents (${normalPriceCents})`,
      );
    }
    if (endsAt < startsAt) {
      throw new Error(`${context}: ends_at (${endsAt}) is before starts_at (${startsAt})`);
    }
    return { productRef: row.ref, normalPriceCents, promoPriceCents, startsAt, endsAt, condition: row.condition };
  });
}

function loadDeliveryZones(): ParsedDeliveryZone[] {
  const rawRows = readCsvRows(path.join(DATA_RAW_DIR, "livraison.csv")).map((row) =>
    RawLivraisonRowSchema.parse(row),
  );
  return rawRows.map((row, index) => {
    const context = `livraison.csv row ${index + 1} (${row.ville})`;
    return {
      city: row.ville,
      feeCents: parseMadToCents(row.frais_mad, context),
      delayHours: parseNonNegativeInteger(row.delai_heures, context),
      cashOnDelivery: parseOuiNonBoolean(row.paiement_a_la_livraison, context),
      storePickup: parseOuiNonBoolean(row.retrait_boutique, context),
    };
  });
}

function loadHistorical(
  customers: ParsedCustomer[],
  products: ParsedProduct[],
): { commandes: ParsedCommande[]; lignes: ParsedLigne[] } {
  const customerExternalRefs = new Set(customers.map((c) => c.externalRef));
  const productRefs = new Set(products.map((p) => p.ref));

  const rawCommandes = readCsvRows(path.join(DATA_RAW_DIR, "commandes.csv")).map((row) =>
    RawCommandeRowSchema.parse(row),
  );
  const commandes = rawCommandes.map((row, index) => {
    const context = `commandes.csv row ${index + 1} (${row.commande_id})`;
    if (!customerExternalRefs.has(row.client_id)) {
      throw new Error(`${context}: client_id "${row.client_id}" does not resolve to any imported customer`);
    }
    return {
      commandeId: row.commande_id,
      clientExternalRef: row.client_id,
      orderDate: parseIsoDate(row.date, context),
      canal: row.canal,
      historicalStatus: row.statut,
      productsTotalCents: parseMadToCents(row.total_articles_mad, context),
      deliveryFeeCents: parseMadToCents(row.frais_livraison_mad, context),
      totalCents: parseMadToCents(row.total_mad, context),
      city: row.ville_livraison,
      paymentMethod: row.paiement,
    };
  });

  const commandeIds = new Set(commandes.map((c) => c.commandeId));
  const rawLignes = readCsvRows(path.join(DATA_RAW_DIR, "commandes-lignes.csv")).map((row) =>
    RawLigneRowSchema.parse(row),
  );
  // source_row_number is assigned here, immediately upon parsing, from the raw file
  // order — before any further processing — so it stays a stable 1-based ordinal
  // over the CSV data rows (header excluded), including for the known duplicate.
  const lignes = rawLignes.map((row, index) => {
    const sourceRowNumber = index + 1;
    const context = `commandes-lignes.csv row ${sourceRowNumber}`;
    if (!commandeIds.has(row.commande_id)) {
      throw new Error(`${context}: commande_id "${row.commande_id}" does not resolve to any historical order`);
    }
    if (!productRefs.has(row.ref)) {
      throw new Error(`${context}: ref "${row.ref}" does not resolve to any imported product`);
    }
    return {
      commandeId: row.commande_id,
      productRef: row.ref,
      model: row.modele,
      size: row.taille,
      quantity: parseNonNegativeInteger(row.quantite, context),
      unitPriceCents: parseMadToCents(row.prix_unitaire_mad, context),
      sourceRowNumber,
    };
  });

  return { commandes, lignes };
}

async function upsertProducts(client: Client, products: ParsedProduct[]): Promise<void> {
  for (const p of products) {
    await client.query(
      `INSERT INTO products (ref, model, family, gender, color, size, material, season, price_cents, stock, barcode, weight_grams, restock_delay_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (ref) DO UPDATE SET
         model = EXCLUDED.model,
         family = EXCLUDED.family,
         gender = EXCLUDED.gender,
         color = EXCLUDED.color,
         size = EXCLUDED.size,
         material = EXCLUDED.material,
         season = EXCLUDED.season,
         price_cents = EXCLUDED.price_cents,
         stock = EXCLUDED.stock,
         barcode = EXCLUDED.barcode,
         weight_grams = EXCLUDED.weight_grams,
         restock_delay_days = EXCLUDED.restock_delay_days,
         imported_at = now()`,
      [
        p.ref,
        p.model,
        p.family,
        p.gender,
        p.color,
        p.size,
        p.material,
        p.season,
        p.priceCents,
        p.stock,
        p.barcode,
        p.weightGrams,
        p.restockDelayDays,
      ],
    );
  }
}

async function upsertCustomers(client: Client, customers: ParsedCustomer[]): Promise<void> {
  for (const c of customers) {
    // created_at is intentionally left untouched on conflict: it marks when this
    // customer record was first created, not when it was last refreshed.
    await client.query(
      `INSERT INTO customers (external_ref, name, phone, city, preferred_language, segment, imported_first_purchase_at, imported_order_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (external_ref) DO UPDATE SET
         name = EXCLUDED.name,
         phone = EXCLUDED.phone,
         city = EXCLUDED.city,
         preferred_language = EXCLUDED.preferred_language,
         segment = EXCLUDED.segment,
         imported_first_purchase_at = EXCLUDED.imported_first_purchase_at,
         imported_order_count = EXCLUDED.imported_order_count`,
      [
        c.externalRef,
        c.name,
        c.phone,
        c.city,
        c.preferredLanguage,
        c.segment,
        c.importedFirstPurchaseAt,
        c.importedOrderCount,
      ],
    );
  }
}

async function fetchCustomerIdByExternalRef(
  client: Client,
  customers: ParsedCustomer[],
): Promise<Map<string, string>> {
  const { rows } = await client.query<{ id: string; external_ref: string }>(
    "SELECT id, external_ref FROM customers WHERE external_ref = ANY($1::text[])",
    [customers.map((c) => c.externalRef)],
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.external_ref, row.id);
  }
  return map;
}

async function refreshPromotions(client: Client, promotions: ParsedPromotion[]): Promise<void> {
  // Full refresh: promotions are current imported truth with no live table owning
  // them, and product_ref/starts_at/ends_at (the real natural key) may legitimately
  // change entirely between snapshots.
  await client.query("DELETE FROM promotions");
  for (const p of promotions) {
    await client.query(
      `INSERT INTO promotions (product_ref, normal_price_cents, promo_price_cents, starts_at, ends_at, condition)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [p.productRef, p.normalPriceCents, p.promoPriceCents, p.startsAt, p.endsAt, p.condition],
    );
  }
}

async function refreshDeliveryZones(client: Client, zones: ParsedDeliveryZone[]): Promise<void> {
  await client.query("DELETE FROM delivery_zones");
  for (const z of zones) {
    await client.query(
      `INSERT INTO delivery_zones (city, fee_cents, delay_hours, cash_on_delivery, store_pickup)
       VALUES ($1,$2,$3,$4,$5)`,
      [z.city, z.feeCents, z.delayHours, z.cashOnDelivery, z.storePickup],
    );
  }
}

async function clearHistoricalSnapshot(client: Client): Promise<void> {
  await client.query("DELETE FROM historical_order_items");
  await client.query("DELETE FROM historical_orders");
}

async function insertHistoricalOrders(
  client: Client,
  commandes: ParsedCommande[],
  customerIdByExternalRef: Map<string, string>,
): Promise<void> {
  for (const c of commandes) {
    const customerId = customerIdByExternalRef.get(c.clientExternalRef);
    if (!customerId) {
      throw new Error(
        `historical order ${c.commandeId}: client_id "${c.clientExternalRef}" does not resolve to a customer id`,
      );
    }
    await client.query(
      `INSERT INTO historical_orders (commande_id, customer_id, order_date, canal, historical_status, products_total_cents, delivery_fee_cents, total_cents, city, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        c.commandeId,
        customerId,
        c.orderDate,
        c.canal,
        c.historicalStatus,
        c.productsTotalCents,
        c.deliveryFeeCents,
        c.totalCents,
        c.city,
        c.paymentMethod,
      ],
    );
  }
}

async function insertHistoricalOrderItems(client: Client, lignes: ParsedLigne[]): Promise<void> {
  for (const l of lignes) {
    await client.query(
      `INSERT INTO historical_order_items (commande_id, product_ref, model, size, quantity, unit_price_cents, source_row_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [l.commandeId, l.productRef, l.model, l.size, l.quantity, l.unitPriceCents, l.sourceRowNumber],
    );
  }
}

async function assertCount(
  client: Client,
  label: string,
  sql: string,
  expected: number,
  params: unknown[] = [],
): Promise<void> {
  const { rows } = await client.query<{ count: string }>(sql, params);
  const actual = Number(rows[0]?.count ?? "-1");
  if (actual !== expected) {
    throw new Error(`Cross-check failed: ${label} — expected ${expected}, got ${actual}`);
  }
  console.log(`  OK  ${label}: ${actual}`);
}

async function runCrossChecks(
  client: Client,
  deliveryZoneCount: number,
  importedCustomerExternalRefs: string[],
): Promise<void> {
  console.log("Running source-data cross-checks before COMMIT:");
  await assertCount(client, "A. products count", "SELECT count(*) FROM products", 80);
  // Scoped to the currently loaded clients.csv external refs, not the whole
  // customers table: live M3AK customers (external_ref IS NULL) must never make
  // this check fail, and must never be touched by this seed.
  await assertCount(
    client,
    "B. imported Kenza customers count",
    "SELECT count(*) FROM customers WHERE external_ref = ANY($1::text[])",
    120,
    [importedCustomerExternalRefs],
  );
  await assertCount(client, "C. historical_orders count", "SELECT count(*) FROM historical_orders", 320);
  await assertCount(client, "D. historical_order_items count", "SELECT count(*) FROM historical_order_items", 449);
  await assertCount(client, "E. promotions count", "SELECT count(*) FROM promotions", 12);
  await assertCount(client, "F. delivery_zones count", "SELECT count(*) FROM delivery_zones", deliveryZoneCount);
  await assertCount(client, "G. distinct product refs", "SELECT count(DISTINCT ref) FROM products", 80);
  await assertCount(client, "H. distinct product barcodes", "SELECT count(DISTINCT barcode) FROM products", 80);
  await assertCount(
    client,
    "I. distinct imported Kenza customer external_ref",
    "SELECT count(DISTINCT external_ref) FROM customers WHERE external_ref = ANY($1::text[])",
    120,
    [importedCustomerExternalRefs],
  );
  await assertCount(
    client,
    "J. distinct imported Kenza customer phone",
    "SELECT count(DISTINCT phone) FROM customers WHERE external_ref = ANY($1::text[])",
    120,
    [importedCustomerExternalRefs],
  );
  await assertCount(
    client,
    "K. historical_orders with resolvable customer",
    "SELECT count(*) FROM historical_orders ho JOIN customers c ON c.id = ho.customer_id",
    320,
  );
  await assertCount(
    client,
    "L. promotions with resolvable product_ref",
    "SELECT count(*) FROM promotions p JOIN products pr ON pr.ref = p.product_ref",
    12,
  );
  await assertCount(
    client,
    "M. historical_order_items with resolvable commande_id",
    "SELECT count(*) FROM historical_order_items hoi JOIN historical_orders ho ON ho.commande_id = hoi.commande_id",
    449,
  );
  await assertCount(
    client,
    "N. historical_order_items with resolvable product_ref (current catalogue)",
    "SELECT count(*) FROM historical_order_items hoi JOIN products p ON p.ref = hoi.product_ref",
    449,
  );
  await assertCount(
    client,
    "O. historical_orders violating total_cents = products_total_cents + delivery_fee_cents",
    "SELECT count(*) FROM historical_orders WHERE total_cents != products_total_cents + delivery_fee_cents",
    0,
  );
  await assertCount(
    client,
    "P. historical_orders where line-item aggregate != products_total_cents",
    `SELECT count(*) FROM historical_orders ho
     WHERE ho.products_total_cents != (
       SELECT COALESCE(SUM(quantity * unit_price_cents), 0)
       FROM historical_order_items hoi WHERE hoi.commande_id = ho.commande_id
     )`,
    0,
  );
  await assertCount(client, "Q. products with stock = 0", "SELECT count(*) FROM products WHERE stock = 0", 15);
  await assertCount(
    client,
    "R. CMD-00089/REF-0076 duplicate occurrences",
    "SELECT count(*) FROM historical_order_items WHERE commande_id = 'CMD-00089' AND product_ref = 'REF-0076'",
    2,
  );
}

async function main(): Promise<void> {
  // Require DATABASE_URL explicitly, before ever constructing a Client: this host
  // also has another native PostgreSQL instance on localhost:5432, so silently
  // falling back to pg's implicit connection defaults would be unsafe.
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Seed aborted: DATABASE_URL is missing or empty. No connection attempt was made.");
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");

    const products = loadProducts();
    const customers = loadCustomers();
    const promotions = loadPromotions(products);
    const deliveryZones = loadDeliveryZones();
    const { commandes, lignes } = loadHistorical(customers, products);

    console.log(
      `Parsed: ${products.length} products, ${customers.length} customers, ${promotions.length} promotions, ` +
        `${deliveryZones.length} delivery zones, ${commandes.length} historical orders, ${lignes.length} historical order lines.`,
    );

    await upsertProducts(client, products);
    await upsertCustomers(client, customers);

    const customerIdByExternalRef = await fetchCustomerIdByExternalRef(client, customers);

    await clearHistoricalSnapshot(client);
    await insertHistoricalOrders(client, commandes, customerIdByExternalRef);
    await insertHistoricalOrderItems(client, lignes);

    await refreshPromotions(client, promotions);
    await refreshDeliveryZones(client, deliveryZones);

    await runCrossChecks(
      client,
      deliveryZones.length,
      customers.map((c) => c.externalRef),
    );

    await client.query("COMMIT");
    console.log("Seed completed successfully (COMMIT).");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Seed failed, transaction rolled back:", (error as Error).message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
