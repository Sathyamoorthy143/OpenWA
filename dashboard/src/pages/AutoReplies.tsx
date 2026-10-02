import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Bot, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import {
  type AutomationRule,
  type AutomationRulePayload,
  type WebhookFilterCondition,
  type WebhookFilters,
} from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import {
  useAutomationRulesQuery,
  useCreateAutomationRuleMutation,
  useDeleteAutomationRuleMutation,
  useSessionsQuery,
  useUpdateAutomationRuleMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './AutoReplies.css';

type MatchMode = 'any' | 'contains' | 'equals';

type RuleForm = {
  name: string;
  matchMode: MatchMode;
  matchText: string;
  replyText: string;
  cooldownSeconds: number;
  enabled: boolean;
  skipOwn: boolean;
  skipGroups: boolean;
  extraConditions: WebhookFilterCondition[];
};

const emptyForm: RuleForm = {
  name: '',
  matchMode: 'contains',
  matchText: '',
  replyText: '',
  cooldownSeconds: 60,
  enabled: true,
  skipOwn: true,
  skipGroups: true,
  extraConditions: [],
};

function buildConditions(form: RuleForm): WebhookFilters | null {
  const conditions: WebhookFilterCondition[] = [];
  if (form.skipOwn) conditions.push({ field: 'fromMe', operator: 'is', value: false });
  if (form.skipGroups) conditions.push({ field: 'isGroup', operator: 'is', value: false });
  if (form.matchMode !== 'any' && form.matchText.trim()) {
    conditions.push({ field: 'body', operator: form.matchMode, value: form.matchText.trim() });
  }
  conditions.push(...form.extraConditions);
  return conditions.length ? { conditions } : null;
}

function formFromRule(rule: AutomationRule): RuleForm {
  const form: RuleForm = {
    ...emptyForm,
    name: rule.name,
    replyText: rule.replyText,
    cooldownSeconds: rule.cooldownSeconds,
    enabled: rule.enabled,
    skipOwn: false,
    skipGroups: false,
    matchMode: 'any',
    matchText: '',
    extraConditions: [],
  };
  for (const condition of rule.conditions?.conditions ?? []) {
    if (condition.field === 'body' && (condition.operator === 'contains' || condition.operator === 'equals')) {
      if (form.matchMode === 'any' && typeof condition.value === 'string') {
        form.matchMode = condition.operator;
        form.matchText = condition.value;
        continue;
      }
    } else if (condition.field === 'fromMe' && condition.operator === 'is' && condition.value === false) {
      form.skipOwn = true;
      continue;
    } else if (condition.field === 'isGroup' && condition.operator === 'is' && condition.value === false) {
      form.skipGroups = true;
      continue;
    }
    form.extraConditions.push(condition);
  }
  return form;
}

function toPayload(form: RuleForm): AutomationRulePayload {
  return {
    name: form.name.trim(),
    replyText: form.replyText.trim(),
    conditions: buildConditions(form),
    cooldownSeconds: Math.max(0, Math.floor(form.cooldownSeconds) || 0),
    enabled: form.enabled,
  };
}

export function AutoReplies() {
  const { t } = useTranslation();
  useDocumentTitle(t('autoReplies.title'));
  const { canWrite } = useRole();
  const { data: sessions = [], isLoading: loadingSessions, error: sessionsError } = useSessionsQuery();
  // A failed read is not "no sessions": the gateway may simply be restarting. A failed background refetch keeps
  // the cached list, so only a read that never produced one counts.
  const sessionsFailed = !!sessionsError && sessions.length === 0;
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [form, setForm] = useState<RuleForm>(emptyForm);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AutomationRule | null>(null);
  const toast = useToast();
  const [searchTerm, setSearchTerm] = useState('');

  const {
    data: rules = [],
    isLoading: loadingRules,
    error: rulesError,
  } = useAutomationRulesQuery(selectedSessionId, !!selectedSessionId);
  const createMutation = useCreateAutomationRuleMutation();
  const updateMutation = useUpdateAutomationRuleMutation();
  const deleteMutation = useDeleteAutomationRuleMutation();

  const selectedSession = sessions.find(session => session.id === selectedSessionId);
  const filteredRules = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return rules;
    return rules.filter(rule =>
      [rule.name, rule.replyText].some(value => value.toLowerCase().includes(query)),
    );
  }, [searchTerm, rules]);
  const isSaving = createMutation.isPending || updateMutation.isPending;

  // Select the first session, and again once the selected one is gone (deleted elsewhere): a stale id
  // matches no option, so the select would show another session while every read and write still
  // went to the deleted one.
  useEffect(() => {
    if (sessions.some(session => session.id === selectedSessionId)) return;
    const next = sessions[0]?.id ?? '';
    if (next === selectedSessionId) return;
    setSelectedSessionId(next);
    setForm(emptyForm);
    setEditingRule(null);
  }, [selectedSessionId, sessions]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingRule(null);
  };

  const openEdit = (rule: AutomationRule) => {
    setEditingRule(rule);
    setForm(formFromRule(rule));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const matchSummary = (rule: AutomationRule): string => {
    const conditions = rule.conditions?.conditions ?? [];
    const body = conditions.find(
      c => c.field === 'body' && (c.operator === 'contains' || c.operator === 'equals'),
    );
    if (!body || typeof body.value !== 'string') return t('autoReplies.matchAnyShort');
    return body.operator === 'equals'
      ? t('autoReplies.matchEqualsShort', { text: body.value })
      : t('autoReplies.matchContainsShort', { text: body.value });
  };

  const canSave =
    !!selectedSessionId && !!form.name.trim() && !!form.replyText.trim() && (form.matchMode === 'any' || !!form.matchText.trim());

  const handleSave = async () => {
    if (!canSave) return;
    try {
      if (editingRule) {
        await updateMutation.mutateAsync({
          sessionId: selectedSessionId,
          id: editingRule.id,
          data: toPayload(form),
        });
        toast.success(t('autoReplies.toasts.updated'));
      } else {
        await createMutation.mutateAsync({ sessionId: selectedSessionId, data: toPayload(form) });
        toast.success(t('autoReplies.toasts.created'));
      }
      resetForm();
    } catch (err) {
      toast.error(
        t(editingRule ? 'autoReplies.toasts.updateFailed' : 'autoReplies.toasts.createFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleToggle = async (rule: AutomationRule) => {
    if (!selectedSessionId) return;
    try {
      await updateMutation.mutateAsync({
        sessionId: selectedSessionId,
        id: rule.id,
        data: { enabled: !rule.enabled },
      });
      toast.success(t('autoReplies.toasts.toggled'));
    } catch (err) {
      toast.error(
        t('autoReplies.toasts.updateFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleDelete = async () => {
    if (!selectedSessionId || !deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: selectedSessionId, id: deleteTarget.id });
      toast.success(t('autoReplies.toasts.deleted'));
      if (editingRule?.id === deleteTarget.id) resetForm();
      setDeleteTarget(null);
    } catch (err) {
      toast.error(
        t('autoReplies.toasts.deleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  if (loadingSessions) {
    return (
      <div className="autoreplies-page autoreplies-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="autoreplies-page">
      <PageHeader
        title={t('autoReplies.title')}
        subtitle={t('autoReplies.subtitle')}
        actions={
          <select
            className="autoreplies-session-select"
            aria-label={t('autoReplies.sessionSelect')}
            value={selectedSessionId}
            onChange={event => {
              setSelectedSessionId(event.target.value);
              resetForm();
            }}
          >
            {sessions.length === 0 && (
              <option value="">{t(sessionsFailed ? 'dashboard.loadError' : 'autoReplies.noSessions')}</option>
            )}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        }
      />

      {sessionsFailed ? (
        <div className="autoreplies-empty-page" role="alert">
          <AlertCircle size={48} strokeWidth={1} />
          <h3>{t('dashboard.loadError')}</h3>
          <p>{sessionsError.message}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="autoreplies-empty-page">
          <Bot size={48} strokeWidth={1} />
          <h3>{t('autoReplies.empty.noSessionsTitle')}</h3>
          <p>{t('autoReplies.empty.noSessionsDesc')}</p>
        </div>
      ) : (
        <div className="autoreplies-workspace">
          <aside className="autoreplies-library">
            <div className="autoreplies-library-header">
              <div>
                <h2>{t('autoReplies.savedTitle')}</h2>
                <span>{t('autoReplies.count', { count: rules.length })}</span>
              </div>
              <button className="btn-primary autoreplies-new-btn" onClick={resetForm} disabled={!canWrite}>
                <Plus size={16} />
                {t('autoReplies.newRule')}
              </button>
            </div>

            <div className="autoreplies-search">
              <Search size={16} />
              <input
                value={searchTerm}
                onChange={event => setSearchTerm(event.target.value)}
                placeholder={t('common.search')}
              />
            </div>

            {loadingRules ? (
              <div className="autoreplies-loading-inline">
                <Loader2 className="animate-spin" size={24} />
              </div>
            ) : rulesError && rules.length === 0 ? (
              <div className="autoreplies-empty-list" role="alert">
                <AlertCircle size={40} strokeWidth={1} />
                {(rulesError as { status?: number }).status === 403 ? (
                  <>
                    <h3>{t('autoReplies.empty.forbiddenTitle')}</h3>
                    <p>{t('autoReplies.empty.forbiddenDesc')}</p>
                  </>
                ) : (
                  <>
                    <h3>{t('autoReplies.empty.loadErrorTitle')}</h3>
                    <p>{rulesError.message}</p>
                  </>
                )}
              </div>
            ) : rules.length === 0 ? (
              <div className="autoreplies-empty-list">
                <Bot size={40} strokeWidth={1} />
                <h3>{t('autoReplies.empty.title')}</h3>
                <p>{t('autoReplies.empty.description')}</p>
              </div>
            ) : filteredRules.length === 0 ? (
              <div className="autoreplies-empty-list compact">
                <Search size={32} strokeWidth={1.5} />
                <h3>{t('autoReplies.empty.noMatch')}</h3>
              </div>
            ) : (
              <div className="autoreplies-list" role="list">
                {filteredRules.map(rule => {
                  const isSelected = editingRule?.id === rule.id;
                  return (
                    <div
                      key={rule.id}
                      className={`autoreplies-list-row ${canWrite ? 'deletable' : ''}`}
                      role="listitem"
                    >
                      <button
                        className={`autoreplies-list-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => openEdit(rule)}
                        type="button"
                      >
                        <span className="autoreplies-list-title">
                          {rule.name}
                          <span className={`autoreplies-status ${rule.enabled ? 'on' : 'off'}`}>
                            {t(rule.enabled ? 'autoReplies.enabledOn' : 'autoReplies.enabledOff')}
                          </span>
                        </span>
                        <span className="autoreplies-list-body">{matchSummary(rule)}</span>
                        <span className="autoreplies-list-meta">{rule.replyText}</span>
                      </button>
                      {canWrite && (
                        <>
                          <button
                            className="icon-btn autoreplies-list-toggle"
                            title={t('autoReplies.actions.toggle')}
                            aria-label={t('autoReplies.actions.toggle')}
                            onClick={() => void handleToggle(rule)}
                            type="button"
                          >
                            <span className={`autoreplies-switch ${rule.enabled ? 'on' : ''}`} aria-hidden="true" />
                          </button>
                          <button
                            className="icon-btn danger autoreplies-list-delete"
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                            onClick={() => setDeleteTarget(rule)}
                            type="button"
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </aside>

          <section className="autoreplies-editor">
            <div className="autoreplies-editor-header">
              <div>
                <h2>{editingRule ? t('autoReplies.editTitle') : t('autoReplies.createTitle')}</h2>
                <p>{selectedSession ? t('autoReplies.sessionHint', { name: selectedSession.name }) : ''}</p>
              </div>
              {editingRule && canWrite && (
                <button
                  className="icon-btn danger"
                  title={t('common.delete')}
                  onClick={() => setDeleteTarget(editingRule)}
                  type="button"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>

            <div className="autoreplies-form">
              <div className="form-group">
                <label htmlFor="ar-1">{t('common.name')}</label>
                <input
                  id="ar-1"
                  value={form.name}
                  onChange={event => setForm({ ...form, name: event.target.value })}
                  placeholder={t('autoReplies.namePlaceholder')}
                  disabled={!canWrite}
                />
              </div>

              <div className="form-group">
                <label htmlFor="ar-2">{t('autoReplies.matchLabel')}</label>
                <select
                  id="ar-2"
                  value={form.matchMode}
                  onChange={event =>
                    setForm({ ...form, matchMode: event.target.value as MatchMode })
                  }
                  disabled={!canWrite}
                >
                  <option value="any">{t('autoReplies.matchAny')}</option>
                  <option value="contains">{t('autoReplies.matchContains')}</option>
                  <option value="equals">{t('autoReplies.matchEquals')}</option>
                </select>
              </div>

              {form.matchMode !== 'any' && (
                <div className="form-group">
                  <label htmlFor="ar-3">{t('autoReplies.matchText')}</label>
                  <input
                    id="ar-3"
                    value={form.matchText}
                    onChange={event => setForm({ ...form, matchText: event.target.value })}
                    placeholder={t('autoReplies.matchTextPlaceholder')}
                    disabled={!canWrite}
                  />
                </div>
              )}

              <div className="form-group">
                <label htmlFor="ar-4">{t('autoReplies.reply')}</label>
                <textarea
                  id="ar-4"
                  value={form.replyText}
                  onChange={event => setForm({ ...form, replyText: event.target.value })}
                  placeholder={t('autoReplies.replyPlaceholder')}
                  rows={5}
                  disabled={!canWrite}
                />
              </div>

              <div className="form-group">
                <label htmlFor="ar-5">{t('autoReplies.cooldown')}</label>
                <input
                  id="ar-5"
                  type="number"
                  min={0}
                  max={86400}
                  value={form.cooldownSeconds}
                  onChange={event =>
                    setForm({ ...form, cooldownSeconds: Number(event.target.value) })
                  }
                  disabled={!canWrite}
                />
                <p className="autoreplies-hint">{t('autoReplies.cooldownHint')}</p>
              </div>

              <div className="autoreplies-checks">
                <label>
                  <input
                    type="checkbox"
                    checked={form.skipOwn}
                    onChange={event => setForm({ ...form, skipOwn: event.target.checked })}
                    disabled={!canWrite}
                  />
                  {t('autoReplies.skipOwn')}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.skipGroups}
                    onChange={event => setForm({ ...form, skipGroups: event.target.checked })}
                    disabled={!canWrite}
                  />
                  {t('autoReplies.skipGroups')}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={event => setForm({ ...form, enabled: event.target.checked })}
                    disabled={!canWrite}
                  />
                  {t('autoReplies.enabled')}
                </label>
              </div>

              <div className="autoreplies-editor-actions">
                <button className="btn-secondary" onClick={resetForm} disabled={isSaving} type="button">
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-primary"
                  onClick={handleSave}
                  disabled={!canWrite || isSaving || !canSave}
                  type="button"
                >
                  {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                  {canWrite
                    ? t(editingRule ? 'autoReplies.saveChanges' : 'autoReplies.createRule')
                    : t('autoReplies.viewOnly')}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {deleteTarget && (
        <Modal
          open
          onClose={() => setDeleteTarget(null)}
          title={t('autoReplies.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('autoReplies.deleteConfirm', { name: deleteTarget.name })}</p>
        </Modal>
      )}
    </div>
  );
}
