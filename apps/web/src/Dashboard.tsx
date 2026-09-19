import { useCallback, useEffect, useRef, useState } from "react";
import {
  DASHBOARD_ERROR_MESSAGE,
  formatConversionRate,
  formatDashboardDate,
  formatMad,
  getDashboardLanguageLabel,
  getDashboardStatusLabel,
  parseDashboardResponse,
  type DashboardData,
} from "./dashboard";

interface DashboardProps {
  apiUrl: string | null;
}

function EmptyRow({ children, columns }: { children: string; columns: number }) {
  return <tr><td className="dashboard-empty" colSpan={columns}>{children}</td></tr>;
}

export function Dashboard({ apiUrl }: DashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const loadDashboard = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setLoading(true);
    setError(null);

    if (apiUrl === null) {
      setLoading(false);
      setError(DASHBOARD_ERROR_MESSAGE);
      return;
    }

    try {
      const response = await fetch(apiUrl, { signal: controller.signal });
      if (!response.ok) throw new Error("Dashboard request failed");
      const parsed = parseDashboardResponse(await response.json());
      if (parsed === null) throw new Error("Dashboard response failed validation");
      if (requestGeneration.current !== generation) return;
      setData(parsed);
    } catch (caught) {
      if (controller.signal.aborted || requestGeneration.current !== generation) return;
      setData(null);
      setError(DASHBOARD_ERROR_MESSAGE);
    } finally {
      if (requestGeneration.current === generation) {
        activeController.current = null;
        setLoading(false);
      }
    }
  }, [apiUrl]);

  useEffect(() => {
    void loadDashboard();
    return () => {
      requestGeneration.current += 1;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, [loadDashboard]);

  return (
    <section className="dashboard" aria-labelledby="dashboard-title">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">Vue opérationnelle</p>
          <h1 id="dashboard-title">Dashboard commerçant</h1>
          <p>Les indicateurs et activités M3AK enregistrés dans PostgreSQL.</p>
        </div>
        <button className="dashboard-refresh" type="button" onClick={() => void loadDashboard()} disabled={loading}>
          <span aria-hidden="true">↻</span>
          Actualiser
        </button>
      </header>

      {error !== null ? (
        <div className="dashboard-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void loadDashboard()}>Réessayer</button>
        </div>
      ) : null}

      {loading && data === null ? (
        <div className="dashboard-loading" role="status">
          <span aria-hidden="true" />
          Chargement du dashboard…
        </div>
      ) : null}

      {data !== null ? (
        <>
          <section className="kpi-grid" aria-label="Indicateurs principaux">
            <article className="kpi-card"><span>Conversations</span><strong>{data.metrics.conversations}</strong></article>
            <article className="kpi-card"><span>Commandes</span><strong>{data.metrics.orders}</strong></article>
            <article className="kpi-card"><span>Conversion</span><strong>{formatConversionRate(data.metrics.conversionRate)}</strong></article>
            <article className="kpi-card"><span>Escalades ouvertes</span><strong>{data.metrics.openEscalations}</strong></article>
            <article className="kpi-card"><span>Relances planifiées</span><strong>{data.metrics.scheduledFollowups}</strong></article>
            <article className="kpi-card kpi-card--value"><span>Valeur des commandes</span><strong>{formatMad(data.metrics.orderValueCents)}</strong></article>
          </section>

          <div className="dashboard-sections">
            <section className="dashboard-section" aria-labelledby="recent-conversations">
              <h2 id="recent-conversations">Conversations récentes</h2>
              <div className="dashboard-table-wrap"><table><thead><tr><th>Client</th><th>Langue</th><th>Statut</th><th>Messages</th><th>Commande</th><th>Escalade</th><th>Dernière activité</th></tr></thead>
                <tbody>{data.conversations.length === 0 ? <EmptyRow columns={7}>Aucune conversation enregistrée.</EmptyRow> : data.conversations.map((item, index) => (
                  <tr key={`${item.customerRef}-${item.updatedAt}-${index}`}><td data-label="Client">{item.customerRef}</td><td data-label="Langue">{getDashboardLanguageLabel(item.language)}</td><td data-label="Statut"><span className={`status-badge status-badge--${item.status}`}>{getDashboardStatusLabel(item.status)}</span></td><td data-label="Messages">{item.messageCount}</td><td data-label="Commande">{item.hasOrder ? "Oui" : "Non"}</td><td data-label="Escalade">{item.hasOpenEscalation ? "Oui" : "Non"}</td><td data-label="Dernière activité">{formatDashboardDate(item.updatedAt)}</td></tr>
                ))}</tbody></table></div>
            </section>

            <section className="dashboard-section" aria-labelledby="recent-orders">
              <h2 id="recent-orders">Commandes récentes</h2>
              <div className="dashboard-table-wrap"><table><thead><tr><th>Client</th><th>Statut</th><th>Montant</th><th>Date</th></tr></thead>
                <tbody>{data.orders.length === 0 ? <EmptyRow columns={4}>Aucune commande M3AK confirmée.</EmptyRow> : data.orders.map((item, index) => (
                  <tr key={`${item.customerRef}-${item.createdAt}-${index}`}><td data-label="Client">{item.customerRef}</td><td data-label="Statut"><span className="status-badge status-badge--confirmed">{getDashboardStatusLabel(item.status)}</span></td><td data-label="Montant">{formatMad(item.totalCents)}</td><td data-label="Date">{formatDashboardDate(item.createdAt)}</td></tr>
                ))}</tbody></table></div>
            </section>

            <section className="dashboard-section" aria-labelledby="escalations">
              <h2 id="escalations">Escalades</h2>
              <div className="dashboard-table-wrap"><table><thead><tr><th>Client</th><th>Motif</th><th>Statut</th><th>Date</th></tr></thead>
                <tbody>{data.escalations.length === 0 ? <EmptyRow columns={4}>Aucune escalade enregistrée.</EmptyRow> : data.escalations.map((item, index) => (
                  <tr key={`${item.customerRef}-${item.createdAt}-${index}`}><td data-label="Client">{item.customerRef}</td><td data-label="Motif">{item.reasonLabel}</td><td data-label="Statut"><span className={`status-badge status-badge--${item.status}`}>{getDashboardStatusLabel(item.status)}</span></td><td data-label="Date">{formatDashboardDate(item.createdAt)}</td></tr>
                ))}</tbody></table></div>
            </section>

            <section className="dashboard-section" aria-labelledby="followups">
              <h2 id="followups">Relances</h2>
              <div className="dashboard-table-wrap"><table><thead><tr><th>Client</th><th>Statut</th><th>Planifiée</th><th>Exécutée</th></tr></thead>
                <tbody>{data.followups.length === 0 ? <EmptyRow columns={4}>Aucune relance enregistrée.</EmptyRow> : data.followups.map((item, index) => (
                  <tr key={`${item.customerRef}-${item.scheduledAt}-${index}`}><td data-label="Client">{item.customerRef}</td><td data-label="Statut"><span className={`status-badge status-badge--${item.status}`}>{getDashboardStatusLabel(item.status)}</span></td><td data-label="Planifiée">{formatDashboardDate(item.scheduledAt)}</td><td data-label="Exécutée">{item.executedAt === null ? "—" : formatDashboardDate(item.executedAt)}</td></tr>
                ))}</tbody></table></div>
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}
