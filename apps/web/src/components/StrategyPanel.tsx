import { useEffect, useMemo, useState } from "react";
import type {
  HexString,
  StrategyCapabilities,
  StrategyDefinition,
  StrategyOperand,
  StrategyPriceField,
  StrategyRule,
  StrategyRuleGroup,
  StrategyTemplate,
  StrategyTimeframe,
  StrategyValidationResult
} from "@sinergy/shared";
import { strategyTool } from "../lib/api";
import type { MarketSnapshot, StrategyBacktestBundle } from "../types";

type Props = {
  address?: HexString;
  markets: MarketSnapshot[];
  selectedMarketId?: HexString;
  timeframe: StrategyTimeframe;
  onSelectMarket: (marketId: HexString) => void;
  onTimeframeChange: (timeframe: StrategyTimeframe) => void;
  onBacktestResult: (result: StrategyBacktestBundle | null) => void;
  focusStrategyId?: string | null;
  refreshToken?: number;
};

type RuleSide = "long" | "short";
type RuleScope = "entryRules" | "exitRules";

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function emptyOperand(): StrategyOperand {
  return { type: "price_field", field: "close" };
}

function emptyRule(): StrategyRule {
  return {
    id: makeId("rule"),
    left: emptyOperand(),
    operator: ">",
    right: { type: "constant", value: 0 }
  };
}

function emptyGroup(): StrategyRuleGroup {
  return {
    id: makeId("group"),
    rules: [emptyRule()]
  };
}

function cloneStrategy(strategy: StrategyDefinition) {
  return JSON.parse(JSON.stringify(strategy)) as StrategyDefinition;
}

function formatTimeframe(value: StrategyTimeframe) {
  return value === "1h" ? "1H" : value === "4h" ? "4H" : value === "1d" ? "1D" : value;
}

function formatSideLabel(side: RuleSide) {
  return side === "long" ? "Long" : "Short";
}

function setRuleGroups(
  draft: StrategyDefinition,
  scope: RuleScope,
  side: RuleSide,
  groups: StrategyRuleGroup[]
) {
  return {
    ...draft,
    [scope]: {
      ...draft[scope],
      [side]: groups
    },
    updatedAt: new Date().toISOString()
  };
}

function findIndicatorDefinition(capabilities: StrategyCapabilities | null, kind: string) {
  return capabilities?.indicatorCatalog.find((indicator) => indicator.kind === kind);
}

function applyOperandDefaults(capabilities: StrategyCapabilities | null, operand: StrategyOperand): StrategyOperand {
  if (!capabilities || operand.type !== "indicator_output") {
    return operand;
  }

  const indicator = findIndicatorDefinition(capabilities, operand.indicator);
  if (!indicator) return operand;

  const params = { ...(operand.params ?? {}) };
  for (const param of indicator.params) {
    if (params[param.name] === undefined && param.defaultValue !== undefined) {
      params[param.name] = param.defaultValue;
    }
  }

  return {
    ...operand,
    output: indicator.outputs.includes(operand.output) ? operand.output : indicator.outputs[0],
    params
  };
}

function OperandEditor({
  label,
  operand,
  capabilities,
  onChange
}: {
  label: string;
  operand: StrategyOperand;
  capabilities: StrategyCapabilities | null;
  onChange: (next: StrategyOperand) => void;
}) {
  const indicator = operand.type === "indicator_output"
    ? findIndicatorDefinition(capabilities, operand.indicator)
    : null;

  return (
    <div className="strategy-operand">
      <div className="strategy-operand-head">
        <span className="strategy-inline-label">{label}</span>
      </div>
      <div className="strategy-operand-fields">
        <select
          value={operand.type}
          onChange={(event) => {
            const nextType = event.target.value as StrategyOperand["type"];
            if (nextType === "constant") {
              onChange({ type: "constant", value: 0 });
              return;
            }
            if (nextType === "indicator_output") {
              const defaultIndicator = capabilities?.indicatorCatalog[0];
              if (!defaultIndicator) {
                onChange({ type: "price_field", field: "close" });
                return;
              }
              onChange({
                type: "indicator_output",
                indicator: defaultIndicator.kind,
                output: defaultIndicator.outputs[0],
                params: Object.fromEntries(
                  defaultIndicator.params
                    .filter((param) => param.defaultValue !== undefined)
                    .map((param) => [param.name, param.defaultValue as number])
                )
              });
              return;
            }
            onChange({ type: "price_field", field: "close" });
          }}
        >
          <option value="price_field">Price</option>
          <option value="indicator_output">Indicator</option>
          <option value="constant">Constant</option>
        </select>

        {operand.type === "price_field" && (
          <select
            value={operand.field}
            onChange={(event) =>
              onChange({ type: "price_field", field: event.target.value as StrategyPriceField })
            }
          >
            {capabilities?.priceFields.map((field) => (
              <option key={field} value={field}>
                {field}
              </option>
            ))}
          </select>
        )}

        {operand.type === "constant" && (
          <input
            type="number"
            value={operand.value}
            onChange={(event) => onChange({ type: "constant", value: Number(event.target.value) })}
          />
        )}

        {operand.type === "indicator_output" && indicator && (
          <>
            <label className="strategy-operand-param">
              <span className="strategy-inline-label">Indicator</span>
              <select
                value={operand.indicator}
                onChange={(event) => {
                  const nextIndicator = findIndicatorDefinition(capabilities, event.target.value);
                  if (!nextIndicator) return;
                  onChange({
                    type: "indicator_output",
                    indicator: nextIndicator.kind,
                    output: nextIndicator.outputs[0],
                    params: Object.fromEntries(
                      nextIndicator.params
                        .filter((param) => param.defaultValue !== undefined)
                        .map((param) => [param.name, param.defaultValue as number])
                    )
                  });
                }}
              >
                {capabilities?.indicatorCatalog.map((entry) => (
                  <option key={entry.kind} value={entry.kind}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="strategy-operand-param">
              <span className="strategy-inline-label">Output</span>
              <select
                value={operand.output}
                onChange={(event) => onChange({ ...operand, output: event.target.value as any })}
              >
                {indicator.outputs.map((output) => (
                  <option key={output} value={output}>
                    {output}
                  </option>
                ))}
              </select>
            </label>

            {indicator.params.map((param) => (
              <label className="strategy-operand-param" key={param.name}>
                <span className="strategy-inline-label">{param.label}</span>
                <input
                  type="number"
                  value={operand.params?.[param.name] ?? param.defaultValue ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...operand,
                      params: {
                        ...(operand.params ?? {}),
                        [param.name]: Number(event.target.value)
                      }
                    })
                  }
                  placeholder={param.label}
                />
              </label>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function RuleBuilder({
  title,
  groups,
  capabilities,
  onChange
}: {
  title: string;
  groups: StrategyRuleGroup[];
  capabilities: StrategyCapabilities | null;
  onChange: (next: StrategyRuleGroup[]) => void;
}) {
  return (
    <div className="strategy-rule-builder">
      <div className="strategy-section-head">
        <div className="strategy-section-copy">
          <strong>{title}</strong>
          <small>Any block can trigger. Inside each block, every rule must match.</small>
        </div>
        <button type="button" onClick={() => onChange([...groups, emptyGroup()])}>
          Add Block
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="strategy-empty-state">No blocks configured.</div>
      ) : (
        groups.map((group, groupIndex) => (
          <div className="strategy-rule-group" key={group.id}>
            <div className="strategy-rule-group-head">
              <div className="strategy-section-copy">
                <span className="strategy-rule-group-title">Block #{groupIndex + 1}</span>
                <small>Use another block for an alternative setup.</small>
              </div>
              <button
                type="button"
                onClick={() => onChange(groups.filter((entry) => entry.id !== group.id))}
              >
                Remove Block
              </button>
            </div>

            {group.rules.map((rule, ruleIndex) => (
              <div className="strategy-rule-row" key={rule.id}>
                <div className="strategy-rule-row-head">
                  <div className="strategy-rule-meta">
                    <span>{ruleIndex === 0 ? "IF" : "AND"}</span>
                  </div>
                  <button
                    type="button"
                    className="strategy-remove-rule"
                    onClick={() => {
                      const nextGroups = groups.map((entry) =>
                        entry.id !== group.id
                          ? entry
                          : {
                              ...entry,
                              rules: entry.rules.filter((existing) => existing.id !== rule.id)
                            }
                      );
                      onChange(nextGroups);
                    }}
                  >
                    Remove Rule
                  </button>
                </div>
                <div className="strategy-rule-fields">
                  <div className="strategy-compare-grid">
                    <OperandEditor
                      label="Left"
                      operand={rule.left}
                      capabilities={capabilities}
                      onChange={(next) => {
                        const nextGroups = groups.map((entry) =>
                          entry.id !== group.id
                            ? entry
                            : {
                                ...entry,
                                rules: entry.rules.map((existing) =>
                                  existing.id === rule.id
                                    ? { ...existing, left: applyOperandDefaults(capabilities, next) }
                                    : existing
                                )
                              }
                        );
                        onChange(nextGroups);
                      }}
                    />

                    <label className="strategy-operator-field">
                      <span className="strategy-inline-label">Condition</span>
                      <select
                        value={rule.operator}
                        onChange={(event) => {
                          const nextGroups = groups.map((entry) =>
                            entry.id !== group.id
                              ? entry
                              : {
                                  ...entry,
                                  rules: entry.rules.map((existing) =>
                                    existing.id === rule.id
                                      ? { ...existing, operator: event.target.value as StrategyRule["operator"] }
                                      : existing
                                  )
                                }
                          );
                          onChange(nextGroups);
                        }}
                      >
                        {capabilities?.operators.map((operator) => (
                          <option key={operator} value={operator}>
                            {operator}
                          </option>
                        ))}
                      </select>
                    </label>

                    <OperandEditor
                      label="Right"
                      operand={rule.right}
                      capabilities={capabilities}
                      onChange={(next) => {
                        const nextGroups = groups.map((entry) =>
                          entry.id !== group.id
                            ? entry
                            : {
                                ...entry,
                                rules: entry.rules.map((existing) =>
                                  existing.id === rule.id
                                    ? { ...existing, right: applyOperandDefaults(capabilities, next) }
                                    : existing
                                )
                              }
                        );
                        onChange(nextGroups);
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}

            <button
              type="button"
              className="strategy-add-rule"
              onClick={() => {
                const nextGroups = groups.map((entry) =>
                  entry.id !== group.id
                    ? entry
                    : {
                        ...entry,
                        rules: [...entry.rules, emptyRule()]
                      }
                );
                onChange(nextGroups);
              }}
            >
              Add Rule
            </button>
          </div>
        ))
      )}
    </div>
  );
}

export function StrategyPanel({
  address,
  markets,
  selectedMarketId,
  timeframe,
  onSelectMarket,
  onTimeframeChange,
  onBacktestResult,
  focusStrategyId = null,
  refreshToken = 0
}: Props) {
  const [capabilities, setCapabilities] = useState<StrategyCapabilities | null>(null);
  const [templates, setTemplates] = useState<StrategyTemplate[]>([]);
  const [strategies, setStrategies] = useState<StrategyDefinition[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string>("");
  const [draft, setDraft] = useState<StrategyDefinition | null>(null);
  const [validation, setValidation] = useState<StrategyValidationResult | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<"loading" | "saving" | "validating" | "running" | null>(null);
  const [templateId, setTemplateId] = useState("");

  const selectedMarket = useMemo(
    () => markets.find((market) => market.id === (draft?.marketId ?? selectedMarketId)) ?? markets[0],
    [draft?.marketId, markets, selectedMarketId]
  );

  async function refreshData() {
    if (!address || !selectedMarket) return;
    setBusy("loading");
    try {
      const [capRes, templateRes, strategyRes] = await Promise.all([
        strategyTool<{ capabilities: StrategyCapabilities }>("list_strategy_capabilities", {
          ownerAddress: address
        }),
        strategyTool<{ templates: StrategyTemplate[] }>("list_strategy_templates", {
          ownerAddress: address,
          marketId: selectedMarket.id
        }),
        strategyTool<{ strategies: StrategyDefinition[] }>("list_user_strategies", {
          ownerAddress: address
        })
      ]);
      setCapabilities(capRes.capabilities);
      setTemplates(templateRes.templates);
      setTemplateId((current) => current || templateRes.templates[0]?.id || "");
      setStrategies(strategyRes.strategies);
      if (!selectedStrategyId && strategyRes.strategies[0]) {
        setSelectedStrategyId(strategyRes.strategies[0].id);
        setDraft(strategyRes.strategies[0]);
        onSelectMarket(strategyRes.strategies[0].marketId);
        onTimeframeChange(strategyRes.strategies[0].timeframe);
      }
      if (!strategyRes.strategies.length) {
        setDraft(null);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void refreshData();
  }, [address, selectedMarket?.id, refreshToken]);

  useEffect(() => {
    if (!address || !focusStrategyId || focusStrategyId === selectedStrategyId) return;
    void selectStrategy(focusStrategyId);
  }, [address, focusStrategyId, selectedStrategyId]);

  useEffect(() => {
    if (!draft) return;
    if (draft.timeframe !== timeframe) {
      setDraft({
        ...draft,
        timeframe,
        updatedAt: new Date().toISOString()
      });
    }
  }, [timeframe]);

  useEffect(() => {
    if (!draft || !selectedMarket || draft.marketId === selectedMarket.id) return;
    setDraft({
      ...draft,
      marketId: selectedMarket.id,
      updatedAt: new Date().toISOString()
    });
  }, [selectedMarket?.id]);

  async function selectStrategy(strategyId: string) {
    if (!address) return;
    setSelectedStrategyId(strategyId);
    const result = await strategyTool<{ strategy: StrategyDefinition }>("get_strategy", {
      ownerAddress: address,
      strategyId
    });
    setDraft(result.strategy);
    onSelectMarket(result.strategy.marketId);
    onTimeframeChange(result.strategy.timeframe);
    setValidation(null);
    onBacktestResult(null);
  }

  async function createDraft() {
    if (!address || !selectedMarket) return;
    setBusy("saving");
    try {
      const result = await strategyTool<{ strategy: StrategyDefinition }>("create_strategy_draft", {
        ownerAddress: address,
        marketId: selectedMarket.id,
        name: "New Strategy Draft"
      });
      setDraft(result.strategy);
      setSelectedStrategyId(result.strategy.id);
      setStrategies((current) => [result.strategy, ...current]);
      setValidation(null);
      setStatus("Draft created.");
      onBacktestResult(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function cloneTemplate() {
    if (!address || !selectedMarket || !templateId) return;
    setBusy("saving");
    try {
      const result = await strategyTool<{ strategy: StrategyDefinition }>("clone_strategy_template", {
        ownerAddress: address,
        marketId: selectedMarket.id,
        templateId
      });
      setDraft(result.strategy);
      setSelectedStrategyId(result.strategy.id);
      setStrategies((current) => [result.strategy, ...current]);
      setValidation(null);
      setStatus(`Template '${templateId}' cloned into a new draft.`);
      onTimeframeChange(result.strategy.timeframe);
      onBacktestResult(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function syncDraft(nextDraft = draft) {
    if (!address || !nextDraft) return null;
    const result = await strategyTool<{ strategy: StrategyDefinition }>("update_strategy_draft", {
      ownerAddress: address,
      strategy: {
        ...nextDraft,
        timeframe
      }
    });
    setDraft(result.strategy);
    setStrategies((current) => {
      const exists = current.some((entry) => entry.id === result.strategy.id);
      if (!exists) return [result.strategy, ...current];
      return current.map((entry) => (entry.id === result.strategy.id ? result.strategy : entry));
    });
    return result.strategy;
  }

  async function validateDraft() {
    if (!address || !draft) return;
    setBusy("validating");
    try {
      const synced = await syncDraft();
      if (!synced) return;
      const result = await strategyTool<{ validation: StrategyValidationResult }>(
        "validate_strategy_draft",
        {
          ownerAddress: address,
          strategyId: synced.id
        }
      );
      setValidation(result.validation);
      setStatus(result.validation.ok ? "Draft validation passed." : "Validation issues found.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    if (!address || !draft) return;
    setBusy("saving");
    try {
      const synced = await syncDraft();
      if (!synced) return;
      const result = await strategyTool<{
        strategy: StrategyDefinition;
        validation: StrategyValidationResult;
      }>("save_strategy", {
        ownerAddress: address,
        strategyId: synced.id
      });
      setDraft(result.strategy);
      setValidation(result.validation);
      setStatus(result.validation.ok ? "Strategy saved and versioned." : "Strategy still has validation issues.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function runBacktest() {
    if (!address || !draft) return;
    setBusy("running");
    try {
      const synced = await syncDraft();
      if (!synced) return;
      const result = await strategyTool<StrategyBacktestBundle>("run_strategy_backtest", {
        ownerAddress: address,
        strategyId: synced.id,
        bars: capabilities?.defaults.backtestBars ?? 250
      });
      onBacktestResult(result);
      setStatus(`Backtest finished: ${result.summary.tradeCount} trades, ${result.summary.netPnlPct.toFixed(2)}% net.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  if (!address) {
    return (
      <div className="strategy-panel">
        <div className="strategy-empty-state">Connect wallet to create and test strategies.</div>
      </div>
    );
  }

  return (
    <div className="strategy-panel">
      <div className="strategy-panel-head">
        <div>
          <span className="panel-title">Strategy Builder</span>
          <p>Configura el borrador por secciones: origen, ejecución, riesgo y reglas por lado.</p>
        </div>
        <div className="strategy-head-actions">
          <button type="button" onClick={() => void refreshData()} disabled={busy !== null}>
            Refresh
          </button>
        </div>
      </div>

      <div className="strategy-panel-body">
        <div className="strategy-toolbar-grid">
          <div className="strategy-subsection">
            <div className="strategy-section-head">
              <div className="strategy-section-copy">
                <strong>Draft Workspace</strong>
                <small>Abre un borrador existente o empieza uno nuevo.</small>
              </div>
              <button type="button" onClick={() => void createDraft()} disabled={busy !== null}>
                New Draft
              </button>
            </div>
            <label>
              Strategy
              <select
                value={selectedStrategyId}
                onChange={(event) => void selectStrategy(event.target.value)}
              >
                <option value="">Select draft</option>
                {strategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>
                    {strategy.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="strategy-subsection">
            <div className="strategy-section-head">
              <div className="strategy-section-copy">
                <strong>Template Starter</strong>
                <small>Usa una base prehecha y luego ajústala.</small>
              </div>
              <button type="button" onClick={() => void cloneTemplate()} disabled={!templateId || busy !== null}>
                Clone Template
              </button>
            </div>
            <label>
              Template
              <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                <option value="">Select template</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {!draft ? (
          <div className="strategy-empty-state">Create a draft or clone a template to start.</div>
        ) : (
          <>
            <div className="strategy-subsection">
              <div className="strategy-section-head">
                <div className="strategy-section-copy">
                  <strong>Strategy Basics</strong>
                  <small>Define nombre, mercado y periodicidad principal.</small>
                </div>
              </div>
              <div className="strategy-card-grid">
                <label>
                  Name
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(event) =>
                      setDraft({ ...cloneStrategy(draft), name: event.target.value, updatedAt: new Date().toISOString() })
                    }
                  />
                </label>

                <label>
                  Market
                  <select
                    value={draft.marketId}
                    onChange={(event) => {
                      const nextMarketId = event.target.value as HexString;
                      setDraft({ ...cloneStrategy(draft), marketId: nextMarketId, updatedAt: new Date().toISOString() });
                      onSelectMarket(nextMarketId);
                      onBacktestResult(null);
                    }}
                  >
                    {markets.map((market) => (
                      <option key={market.id} value={market.id}>
                        {market.symbol}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Timeframe
                  <select
                    value={timeframe}
                    onChange={(event) => {
                      onTimeframeChange(event.target.value as StrategyTimeframe);
                      onBacktestResult(null);
                    }}
                  >
                    {capabilities?.timeframes.map((value) => (
                      <option key={value} value={value}>
                        {formatTimeframe(value)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="strategy-layout-split">
              <div className="strategy-subsection">
                <div className="strategy-section-head">
                  <div className="strategy-section-copy">
                    <strong>Position Setup</strong>
                    <small>Elige lados activos, tamaño y capital de prueba.</small>
                  </div>
                </div>
                <div className="strategy-checkboxes">
                  {(["long", "short"] as const).map((side) => (
                    <label key={side} className="strategy-checkbox">
                      <input
                        type="checkbox"
                        checked={draft.enabledSides.includes(side)}
                        onChange={(event) => {
                          const nextSides = event.target.checked
                            ? [...draft.enabledSides, side]
                            : draft.enabledSides.filter((entry) => entry !== side);
                          setDraft({
                            ...cloneStrategy(draft),
                            enabledSides: Array.from(new Set(nextSides)),
                            updatedAt: new Date().toISOString()
                          });
                        }}
                      />
                      {formatSideLabel(side)}
                    </label>
                  ))}
                </div>
                <div className="strategy-card-grid strategy-card-grid-compact">
                  <label>
                    Sizing Mode
                    <select
                      value={draft.sizing.mode}
                      onChange={(event) =>
                        setDraft({
                          ...cloneStrategy(draft),
                          sizing: {
                            ...draft.sizing,
                            mode: event.target.value as StrategyDefinition["sizing"]["mode"]
                          },
                          updatedAt: new Date().toISOString()
                        })
                      }
                    >
                      {capabilities?.sizingModes.map((mode) => (
                        <option key={mode.mode} value={mode.mode}>
                          {mode.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Sizing Value
                    <input
                      type="number"
                      value={draft.sizing.value}
                      onChange={(event) =>
                        setDraft({
                          ...cloneStrategy(draft),
                          sizing: { ...draft.sizing, value: Number(event.target.value) },
                          updatedAt: new Date().toISOString()
                        })
                      }
                    />
                  </label>
                  <label>
                    Starting Equity
                    <input
                      type="number"
                      value={draft.costModel.startingEquity}
                      onChange={(event) =>
                        setDraft({
                          ...cloneStrategy(draft),
                          costModel: { ...draft.costModel, startingEquity: Number(event.target.value) },
                          updatedAt: new Date().toISOString()
                        })
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="strategy-subsection">
                <div className="strategy-section-head">
                  <div className="strategy-section-copy">
                    <strong>Risk And Costs</strong>
                    <small>Costes de ejecución y salidas automáticas del backtest.</small>
                  </div>
                </div>
                <div className="strategy-card-grid strategy-card-grid-compact">
                  <label>
                    Fee Bps
                    <input
                      type="number"
                      value={draft.costModel.feeBps}
                      onChange={(event) =>
                        setDraft({
                          ...cloneStrategy(draft),
                          costModel: { ...draft.costModel, feeBps: Number(event.target.value) },
                          updatedAt: new Date().toISOString()
                        })
                      }
                    />
                  </label>

                  <label>
                    Slippage Bps
                    <input
                      type="number"
                      value={draft.costModel.slippageBps}
                      onChange={(event) =>
                        setDraft({
                          ...cloneStrategy(draft),
                          costModel: { ...draft.costModel, slippageBps: Number(event.target.value) },
                          updatedAt: new Date().toISOString()
                        })
                      }
                    />
                  </label>

                  <label>
                    Stop Loss %
                    <input
                      type="number"
                      value={draft.riskRules.stopLossPct ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...cloneStrategy(draft),
                          riskRules: { ...draft.riskRules, stopLossPct: Number(event.target.value) },
                          updatedAt: new Date().toISOString()
                        })
                      }
                    />
                  </label>

                  <label>
                    Take Profit %
                    <input
                      type="number"
                      value={draft.riskRules.takeProfitPct ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...cloneStrategy(draft),
                          riskRules: { ...draft.riskRules, takeProfitPct: Number(event.target.value) },
                          updatedAt: new Date().toISOString()
                        })
                      }
                    />
                  </label>

                  <label>
                    Trailing Stop %
                    <input
                      type="number"
                      value={draft.riskRules.trailingStopPct ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...cloneStrategy(draft),
                          riskRules: { ...draft.riskRules, trailingStopPct: Number(event.target.value) },
                          updatedAt: new Date().toISOString()
                        })
                      }
                    />
                  </label>

                  <label>
                    Max Bars In Trade
                    <input
                      type="number"
                      value={draft.riskRules.maxBarsInTrade ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...cloneStrategy(draft),
                          riskRules: { ...draft.riskRules, maxBarsInTrade: Number(event.target.value) },
                          updatedAt: new Date().toISOString()
                        })
                      }
                    />
                  </label>
                </div>
              </div>
            </div>

            <div className="strategy-rules-stack">
              {(["long", "short"] as const).map((side) => {
                const sideEnabled = draft.enabledSides.includes(side);
                return (
                  <div key={side} className={`strategy-side-section ${sideEnabled ? "" : "is-disabled"}`}>
                    <div className="strategy-section-head">
                      <div className="strategy-section-copy">
                        <strong>{formatSideLabel(side)} Side</strong>
                        <small>
                          {sideEnabled
                            ? `Define cuándo abrir y cerrar posiciones ${formatSideLabel(side).toLowerCase()}.`
                            : `Activa ${formatSideLabel(side)} arriba para editar estas reglas.`}
                        </small>
                      </div>
                      <span className={`strategy-side-badge ${sideEnabled ? "enabled" : "disabled"}`}>
                        {sideEnabled ? "Enabled" : "Disabled"}
                      </span>
                    </div>

                    {sideEnabled ? (
                      <>
                        <RuleBuilder
                          title="Entry Rules"
                          groups={draft.entryRules[side]}
                          capabilities={capabilities}
                          onChange={(next) => setDraft(setRuleGroups(cloneStrategy(draft), "entryRules", side, next))}
                        />
                        <RuleBuilder
                          title="Exit Rules"
                          groups={draft.exitRules[side]}
                          capabilities={capabilities}
                          onChange={(next) => setDraft(setRuleGroups(cloneStrategy(draft), "exitRules", side, next))}
                        />
                      </>
                    ) : (
                      <div className="strategy-empty-state">
                        Enable {formatSideLabel(side)} in Position Setup to configure these rules.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="strategy-panel-footer">
              <button type="button" onClick={() => void validateDraft()} disabled={busy !== null}>
                Validate
              </button>
              <button type="button" onClick={() => void saveDraft()} disabled={busy !== null}>
                Save
              </button>
              <button type="button" className="strategy-primary-btn" onClick={() => void runBacktest()} disabled={busy !== null}>
                Run Backtest
              </button>
            </div>
          </>
        )}

        {validation && (
          <div className={`strategy-validation ${validation.ok ? "ok" : "error"}`}>
            <strong>{validation.ok ? "Validation passed" : "Validation issues"}</strong>
            {!validation.ok && (
              <div className="strategy-validation-list">
                {validation.issues.slice(0, 8).map((issue) => (
                  <div key={`${issue.path}-${issue.code}`}>
                    <span>{issue.path}</span>
                    <small>
                      {issue.message}
                      {issue.suggestion ? ` Suggestion: ${issue.suggestion}` : ""}
                    </small>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {status && <div className="strategy-status-msg">{status}</div>}
      </div>
    </div>
  );
}
