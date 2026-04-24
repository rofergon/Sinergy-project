import { useEffect, useMemo, useState } from "react";
import type {
  HexString,
  StrategyCapabilities,
  StrategyDefinition,
  StrategyIndicatorKind,
  StrategyIndicatorOutput,
  StrategyIndicatorParams,
  StrategyOperand,
  StrategyPriceField,
  StrategyRule,
  StrategyRuleGroup,
  StrategyTemplate,
  StrategyTimeframe,
  StrategyValidationResult
} from "@sinergy/shared";
import type {
  StrategyValueExpressionV2,
  StrategyConditionExpressionV2
} from "@sinergy/shared";
import { strategyTool } from "../lib/api";
import type { ChartViewport, MarketSnapshot, StrategyBacktestBundle } from "../types";

type Props = {
  address?: HexString;
  markets: MarketSnapshot[];
  selectedMarketId?: HexString;
  timeframe: StrategyTimeframe;
  viewport: ChartViewport | null;
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

function toManualStrategy(strategy: StrategyDefinition): StrategyDefinition {
  if (!strategy.engine) {
    return strategy;
  }

  const next = cloneStrategy(strategy);
  delete next.engine;
  next.updatedAt = new Date().toISOString();
  return next;
}

type ActiveIndicatorEntry = {
  key: string;
  kind: StrategyIndicatorKind;
  label: string;
  output: StrategyIndicatorOutput;
  params: StrategyIndicatorParams;
  barsAgo: number;
  source: "rules" | "engine";
};

function serializeIndicatorKey(
  indicator: StrategyIndicatorKind,
  output: StrategyIndicatorOutput,
  barsAgo: number,
  params?: StrategyIndicatorParams
): string {
  const paramStr = params
    ? Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join("|")
    : "";
  return `${indicator}:${output}:${barsAgo}:${paramStr}`;
}

function extractActiveIndicators(
  draft: StrategyDefinition,
  capabilities: StrategyCapabilities | null
): ActiveIndicatorEntry[] {
  const seenKeys = new Set<string>();
  const result: ActiveIndicatorEntry[] = [];

  const addIndicator = (
    kind: StrategyIndicatorKind,
    output: StrategyIndicatorOutput,
    params: StrategyIndicatorParams,
    barsAgo: number,
    source: "rules" | "engine"
  ) => {
    const key = serializeIndicatorKey(kind, output, barsAgo, params);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const catalogEntry = capabilities?.indicatorCatalog.find((i) => i.kind === kind);
    result.push({
      key,
      kind,
      label: catalogEntry?.label ?? kind.toUpperCase(),
      output,
      params: { ...params },
      barsAgo,
      source
    });
  };

  // ── Scan manual rules (entryRules / exitRules) ──
  const visitOperand = (op: StrategyOperand) => {
    if (op.type !== "indicator_output") return;
    addIndicator(op.indicator, op.output, op.params ?? {}, op.barsAgo ?? 0, "rules");
  };

  const visitGroups = (groups: StrategyRuleGroup[]) => {
    for (const group of groups) {
      for (const rule of group.rules) {
        visitOperand(rule.left);
        visitOperand(rule.right);
      }
    }
  };

  visitGroups(draft.entryRules.long);
  visitGroups(draft.entryRules.short);
  visitGroups(draft.exitRules.long);
  visitGroups(draft.exitRules.short);

  // ── Scan engine AST (bindings + signals) ──
  const ast = draft.engine?.ast;
  if (ast) {
    const visitValueExpr = (expr: StrategyValueExpressionV2): void => {
      if (expr.type === "indicator") {
        addIndicator(
          expr.indicator,
          expr.output,
          expr.params ?? {},
          expr.barsAgo ?? 0,
          "engine"
        );
      } else if (expr.type === "binary_op") {
        visitValueExpr(expr.left);
        visitValueExpr(expr.right);
      } else if (expr.type === "unary_op") {
        visitValueExpr(expr.expression);
      } else if (expr.type === "history_ref") {
        visitValueExpr(expr.expression);
      }
    };

    const visitCondition = (cond: StrategyConditionExpressionV2): void => {
      if (cond.type === "comparison") {
        visitValueExpr(cond.left);
        visitValueExpr(cond.right);
      } else if (cond.type === "logical") {
        for (const sub of cond.conditions) visitCondition(sub);
      } else if (cond.type === "not") {
        visitCondition(cond.condition);
      }
    };

    for (const binding of ast.bindings) {
      visitValueExpr(binding.expression);
    }
    for (const signal of Object.values(ast.signals)) {
      if (signal) visitCondition(signal);
    }
  }

  return result;
}

function serializeOperandKey(op: StrategyOperand): string | null {
  if (op.type !== "indicator_output") return null;
  const params = op.params
    ? Object.entries(op.params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join("|")
    : "";
  return `${op.indicator}:${op.output}:${op.barsAgo ?? 0}:${params}`;
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

function assignIndicatorParam(
  params: StrategyIndicatorParams,
  key: keyof StrategyIndicatorParams,
  value: StrategyIndicatorParams[keyof StrategyIndicatorParams]
) {
  switch (key) {
    case "period":
      if (typeof value === "number") params.period = value;
      break;
    case "fastPeriod":
      if (typeof value === "number") params.fastPeriod = value;
      break;
    case "slowPeriod":
      if (typeof value === "number") params.slowPeriod = value;
      break;
    case "signalPeriod":
      if (typeof value === "number") params.signalPeriod = value;
      break;
    case "smoothK":
      if (typeof value === "number") params.smoothK = value;
      break;
    case "smoothD":
      if (typeof value === "number") params.smoothD = value;
      break;
    case "stdDev":
      if (typeof value === "number") params.stdDev = value;
      break;
    case "lookback":
      if (typeof value === "number") params.lookback = value;
      break;
    case "source":
      if (typeof value === "string") params.source = value;
      break;
  }
}

function buildIndicatorDefaultParams(
  indicator: StrategyCapabilities["indicatorCatalog"][number]
) {
  const params: StrategyIndicatorParams = {};
  for (const param of indicator.params) {
    if (param.type === "source") {
      assignIndicatorParam(params, param.name, "close");
    } else if (param.defaultValue !== undefined) {
      assignIndicatorParam(params, param.name, param.defaultValue);
    }
  }
  return params;
}

function applyOperandDefaults(capabilities: StrategyCapabilities | null, operand: StrategyOperand): StrategyOperand {
  if (!capabilities || operand.type !== "indicator_output") {
    return operand;
  }

  const indicator = findIndicatorDefinition(capabilities, operand.indicator);
  if (!indicator) return operand;

  const params = { ...(operand.params ?? {}) };
  for (const param of indicator.params) {
    if (params[param.name] === undefined && param.type === "source") {
      assignIndicatorParam(params, param.name, "close");
    } else if (params[param.name] === undefined && param.defaultValue !== undefined) {
      assignIndicatorParam(params, param.name, param.defaultValue);
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
  onChange,
  onGlobalSync
}: {
  label: string;
  operand: StrategyOperand;
  capabilities: StrategyCapabilities | null;
  onChange: (next: StrategyOperand) => void;
  onGlobalSync?: (prevKey: string, next: StrategyOperand) => void;
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
              const nextOp: StrategyOperand = {
                type: "indicator_output",
                indicator: defaultIndicator.kind,
                output: defaultIndicator.outputs[0],
                params: buildIndicatorDefaultParams(defaultIndicator)
              };
              onChange(nextOp);
              if (onGlobalSync) {
                const prevKey = serializeOperandKey(operand);
                if (prevKey) onGlobalSync(prevKey, nextOp);
              }
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
          <>
            <select
              value={operand.field}
              onChange={(event) =>
                onChange({
                  type: "price_field",
                  field: event.target.value as StrategyPriceField,
                  barsAgo: operand.barsAgo
                })
              }
            >
              {capabilities?.priceFields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>

            <label className="strategy-operand-param">
              <span className="strategy-inline-label">Bars Ago</span>
              <input
                type="number"
                min={0}
                step={1}
                value={operand.barsAgo ?? 0}
                onChange={(event) =>
                  onChange({
                    ...operand,
                    barsAgo: Math.max(0, Number(event.target.value) || 0)
                  })
                }
              />
            </label>
          </>
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
                  const nextOp: StrategyOperand = {
                    type: "indicator_output",
                    indicator: nextIndicator.kind,
                    output: nextIndicator.outputs[0],
                    params: buildIndicatorDefaultParams(nextIndicator),
                    barsAgo: operand.barsAgo
                  };
                  onChange(nextOp);
                  if (onGlobalSync) {
                    const prevKey = serializeOperandKey(operand);
                    if (prevKey) onGlobalSync(prevKey, nextOp);
                  }
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
                onChange={(event) => {
                  const nextOp: StrategyOperand = { ...operand, output: event.target.value as any };
                  onChange(nextOp);
                  if (onGlobalSync) {
                    const prevKey = serializeOperandKey(operand);
                    if (prevKey) onGlobalSync(prevKey, nextOp);
                  }
                }}
              >
                {indicator.outputs.map((output) => (
                  <option key={output} value={output}>
                    {output}
                  </option>
                ))}
              </select>
            </label>

            <label className="strategy-operand-param">
              <span className="strategy-inline-label">Bars Ago</span>
              <input
                type="number"
                min={0}
                step={1}
                value={operand.barsAgo ?? 0}
                onChange={(event) => {
                  const nextOp: StrategyOperand = {
                    ...operand,
                    barsAgo: Math.max(0, Number(event.target.value) || 0)
                  };
                  onChange(nextOp);
                  if (onGlobalSync) {
                    const prevKey = serializeOperandKey(operand);
                    if (prevKey) onGlobalSync(prevKey, nextOp);
                  }
                }}
              />
            </label>

            {indicator.params.map((param) => (
              <label className="strategy-operand-param" key={param.name}>
                <span className="strategy-inline-label">{param.label}</span>
                {param.type === "source" ? (
                  <select
                    value={String(operand.params?.[param.name] ?? "close")}
                    onChange={(event) => {
                      const nextParams: StrategyIndicatorParams = { ...(operand.params ?? {}) };
                      assignIndicatorParam(nextParams, param.name, event.target.value as StrategyPriceField);
                      const nextOp: StrategyOperand = {
                        ...operand,
                        params: nextParams
                      };
                      onChange(nextOp);
                      if (onGlobalSync) {
                        const prevKey = serializeOperandKey(operand);
                        if (prevKey) onGlobalSync(prevKey, nextOp);
                      }
                    }}
                  >
                    {(param.options ?? capabilities?.priceFields ?? []).map((field) => (
                      <option key={field} value={field}>
                        {field}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    min={param.min}
                    max={param.max}
                    step={param.type === "integer" ? 1 : "any"}
                    value={operand.params?.[param.name] ?? param.defaultValue ?? ""}
                    onChange={(event) => {
                      const rawValue = Number(event.target.value);
                      const nextParams: StrategyIndicatorParams = { ...(operand.params ?? {}) };
                      assignIndicatorParam(
                        nextParams,
                        param.name,
                        param.type === "integer" ? Math.trunc(rawValue) : rawValue
                      );
                      const nextOp: StrategyOperand = {
                        ...operand,
                        params: nextParams
                      };
                      onChange(nextOp);
                      if (onGlobalSync) {
                        const prevKey = serializeOperandKey(operand);
                        if (prevKey) onGlobalSync(prevKey, nextOp);
                      }
                    }}
                    placeholder={param.label}
                  />
                )}
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
  onChange,
  onGlobalSync
}: {
  title: string;
  groups: StrategyRuleGroup[];
  capabilities: StrategyCapabilities | null;
  onChange: (next: StrategyRuleGroup[]) => void;
  onGlobalSync?: (prevKey: string, next: StrategyOperand) => void;
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
                      onGlobalSync={onGlobalSync}
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
                      onGlobalSync={onGlobalSync}
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
  viewport,
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
  const [rulesExpanded, setRulesExpanded] = useState(false);
  const [activeSide, setActiveSide] = useState<RuleSide>("long");
  const activeIndicators = useMemo(
    () => (draft ? extractActiveIndicators(draft, capabilities) : []),
    [draft, capabilities]
  );

  const isDirty = useMemo(() => {
    if (!draft) return false;
    const original = strategies.find(s => s.id === draft.id);
    if (!original) return true;
    return draft.updatedAt !== original.updatedAt;
  }, [draft, strategies]);

  const handleGlobalSync = (prevKey: string, nextOp: StrategyOperand) => {
    setDraft((current) => {
      if (!current) return current;
      const base = toManualStrategy(current);
      const syncGroup = (group: StrategyRuleGroup) => ({
        ...group,
        rules: group.rules.map(rule => ({
          ...rule,
          left: serializeOperandKey(rule.left) === prevKey ? { ...nextOp } : rule.left,
          right: serializeOperandKey(rule.right) === prevKey ? { ...nextOp } : rule.right,
        }))
      });
      return {
        ...base,
        entryRules: {
          long: base.entryRules.long.map(syncGroup),
          short: base.entryRules.short.map(syncGroup),
        },
        exitRules: {
          long: base.exitRules.long.map(syncGroup),
          short: base.exitRules.short.map(syncGroup),
        },
        updatedAt: new Date().toISOString()
      };
    });
  };

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
    void selectStrategy(focusStrategyId, { preserveBacktest: true });
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

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => {
      setStatus("");
    }, 4000);
    return () => clearTimeout(timer);
  }, [status]);

  async function selectStrategy(strategyId: string, options?: { preserveBacktest?: boolean }) {
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
    if (!options?.preserveBacktest) {
      onBacktestResult(null);
    }
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

  async function deleteDraft() {
    if (!address || !draft) return;
    const confirmed = window.confirm(`Delete strategy "${draft.name}"? This will also remove its backtests and live execution history.`);
    if (!confirmed) return;

    setBusy("saving");
    try {
      await strategyTool<{ strategyId: string; deleted: true }>("delete_strategy", {
        ownerAddress: address,
        strategyId: draft.id
      });

      const remaining = strategies.filter((entry) => entry.id !== draft.id);
      setStrategies(remaining);
      setValidation(null);
      setSelectedStrategyId(remaining[0]?.id ?? "");
      setStatus("Strategy deleted.");
      onBacktestResult(null);

      if (remaining[0]) {
        const next = await strategyTool<{ strategy: StrategyDefinition }>("get_strategy", {
          ownerAddress: address,
          strategyId: remaining[0].id
        });
        setDraft(next.strategy);
        onSelectMarket(next.strategy.marketId);
        onTimeframeChange(next.strategy.timeframe);
      } else {
        setDraft(null);
      }
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
        ...(viewport
          ? {
              bars: viewport.bars,
              fromTs: viewport.fromTs,
              toTs: viewport.toTs
            }
          : { bars: capabilities?.defaults.backtestBars ?? 250 })
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

  function updateIndicatorParam(
    indicatorEntry: ActiveIndicatorEntry,
    paramName: keyof StrategyIndicatorParams,
    rawValue: string | number
  ) {
    if (!draft) return;
    const nextDraft = cloneStrategy(draft);
    const value = typeof rawValue === "string" ? (paramName === "source" ? rawValue : Number(rawValue)) : rawValue;

    // ── Patch manual rule operands ──
    const patchOperand = (op: StrategyOperand): StrategyOperand => {
      if (op.type !== "indicator_output") return op;
      const key = serializeIndicatorKey(op.indicator, op.output, op.barsAgo ?? 0, op.params);
      if (key !== indicatorEntry.key) return op;
      const nextParams = { ...(op.params ?? {}) };
      assignIndicatorParam(nextParams, paramName, value as StrategyIndicatorParams[keyof StrategyIndicatorParams]);
      return { ...op, params: nextParams };
    };

    const patchGroups = (groups: StrategyRuleGroup[]) =>
      groups.map((g) => ({
        ...g,
        rules: g.rules.map((r) => ({
          ...r,
          left: patchOperand(r.left),
          right: patchOperand(r.right)
        }))
      }));

    nextDraft.entryRules.long = patchGroups(nextDraft.entryRules.long);
    nextDraft.entryRules.short = patchGroups(nextDraft.entryRules.short);
    nextDraft.exitRules.long = patchGroups(nextDraft.exitRules.long);
    nextDraft.exitRules.short = patchGroups(nextDraft.exitRules.short);

    // ── Patch engine AST ──
    if (nextDraft.engine?.ast) {
      const patchValueExpr = (expr: StrategyValueExpressionV2): StrategyValueExpressionV2 => {
        if (expr.type === "indicator") {
          const key = serializeIndicatorKey(expr.indicator, expr.output, expr.barsAgo ?? 0, expr.params);
          if (key === indicatorEntry.key) {
            const nextParams = { ...(expr.params ?? {}) };
            assignIndicatorParam(nextParams, paramName, value as StrategyIndicatorParams[keyof StrategyIndicatorParams]);
            return { ...expr, params: nextParams };
          }
          return expr;
        }
        if (expr.type === "binary_op") {
          return { ...expr, left: patchValueExpr(expr.left), right: patchValueExpr(expr.right) };
        }
        if (expr.type === "unary_op") {
          return { ...expr, expression: patchValueExpr(expr.expression) };
        }
        if (expr.type === "history_ref") {
          return { ...expr, expression: patchValueExpr(expr.expression) };
        }
        return expr;
      };

      const patchCondition = (cond: StrategyConditionExpressionV2): StrategyConditionExpressionV2 => {
        if (cond.type === "comparison") {
          return { ...cond, left: patchValueExpr(cond.left), right: patchValueExpr(cond.right) };
        }
        if (cond.type === "logical") {
          return { ...cond, conditions: cond.conditions.map(patchCondition) };
        }
        if (cond.type === "not") {
          return { ...cond, condition: patchCondition(cond.condition) };
        }
        return cond;
      };

      nextDraft.engine.ast.bindings = nextDraft.engine.ast.bindings.map((b) => ({
        ...b,
        expression: patchValueExpr(b.expression)
      }));

      const signals = nextDraft.engine.ast.signals;
      for (const signalKey of Object.keys(signals) as Array<keyof typeof signals>) {
        const signal = signals[signalKey];
        if (signal) {
          signals[signalKey] = patchCondition(signal);
        }
      }

      nextDraft.engine.sourceType = "ast_v2";
    }

    nextDraft.updatedAt = new Date().toISOString();
    setDraft(nextDraft);
  }

  return (
    <div className="strategy-panel">
      <div className="strategy-panel-body">
        {!draft ? (
          <div className="strategy-empty-state">
            No strategy loaded. Create one from the agent or open an existing session.
          </div>
        ) : (
          <>
            {/* ── HEADER COMPACTO ── */}
            <div className="se-header">
              <div className="se-header-name-row">
                <span className="se-header-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </span>
                <div className="se-header-title-stack">
                  <input
                    type="text"
                    className="se-header-name-input"
                    value={draft.name}
                    onChange={(event) =>
                      setDraft({ ...cloneStrategy(draft), name: event.target.value, updatedAt: new Date().toISOString() })
                    }
                    spellCheck={false}
                    aria-label="Strategy name"
                  />
                  <div className="se-header-chips">
                    <span className="se-chip">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: 4}}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      {selectedMarket?.symbol ?? "--"}
                    </span>
                    <span className="se-chip">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: 4}}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      {formatTimeframe(timeframe)}
                    </span>
                    <span className="se-chip">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: 4}}><path d="M7 16V4M7 4L3 8M7 4L11 8M17 8V20M17 20L21 16M17 20L13 16"/></svg>
                      {draft.enabledSides.map((s) => formatSideLabel(s)).join(" + ")}
                    </span>
                    <span className={`se-chip ${draft.status === "saved" ? "se-chip-ok" : "se-chip-draft"}`}>
                      {draft.status === "saved" ? "Saved" : "Draft"}
                    </span>
                    {isDirty && (
                      <span className="se-chip se-chip-dirty">Unsaved Changes</span>
                    )}
                  </div>
                </div>
                <button type="button" className="se-header-collapse" aria-label="Collapse strategy summary">
                  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                </button>
              </div>
            </div>

            {/* ── INDICADORES ACTIVOS ── */}
            <div className="se-section">
              <div className="se-section-head">
                <div className="se-section-copy">
                  <strong>Active indicators</strong>
                  <small>Shared indicator inputs. Changing one here updates every rule that uses the same signal.</small>
                </div>
                <span className="se-section-count">{activeIndicators.length} active</span>
              </div>

              {activeIndicators.length === 0 ? (
                <div className="strategy-empty-state">
                  No indicators detected. The rules use only price or constants.
                </div>
              ) : (
                <div className="se-indicator-grid">
                  {activeIndicators.map((entry) => {
                    const catalogEntry = capabilities?.indicatorCatalog.find(
                      (i) => i.kind === entry.kind
                    );
                    return (
                      <div className="se-indicator-card" key={entry.key}>
                        <div className="se-indicator-card-head">
                          <div className="se-indicator-title">
                            <span className="se-indicator-dot" />
                            <strong title={entry.label}>{entry.label}</strong>
                          </div>
                          <span className="se-indicator-type-badge">{entry.output}</span>
                        </div>
                        <div className="se-indicator-params">
                          {catalogEntry?.params.map((param) => (
                            <label key={param.name} className="se-indicator-param">
                              <span>{param.label}</span>
                              {param.type === "source" ? (
                                <select
                                  value={String(entry.params[param.name] ?? "close")}
                                  onChange={(ev) =>
                                    updateIndicatorParam(entry, param.name, ev.target.value)
                                  }
                                >
                                  {(param.options ?? capabilities?.priceFields ?? []).map((f) => (
                                    <option key={f} value={f}>{f}</option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="number"
                                  min={param.min}
                                  max={param.max}
                                  step={param.type === "integer" ? 1 : "any"}
                                  value={entry.params[param.name] ?? param.defaultValue ?? ""}
                                  onChange={(ev) =>
                                    updateIndicatorParam(entry, param.name, ev.target.value)
                                  }
                                />
                              )}
                            </label>
                          ))}
                          {entry.barsAgo > 0 && (
                            <label className="se-indicator-param">
                              <span>Bars Ago</span>
                              <input type="number" value={entry.barsAgo} readOnly />
                            </label>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── GESTIÓN DE RIESGO ── */}
            <div className="se-section">
              <div className="se-section-head">
                <div className="se-section-copy">
                  <strong>Risk management</strong>
                  <small>Automatic exits, trade duration, and cost assumptions for backtests.</small>
                </div>
              </div>
              <div className="se-risk-groups">
                <div className="se-risk-subgroup exits">
                  <div className="se-risk-subgroup-head">
                    <span className="se-risk-kicker">Exits</span>
                    <small>Percent values are measured from entry price.</small>
                  </div>
                  <div className="se-risk-grid">
                    <label className="se-risk-field">
                      <span>Stop Loss %</span>
                      <input
                        type="number"
                        value={draft.riskRules.stopLossPct ?? ""}
                        placeholder="--"
                        onChange={(ev) =>
                          setDraft({
                            ...cloneStrategy(draft),
                            riskRules: { ...draft.riskRules, stopLossPct: Number(ev.target.value) },
                            updatedAt: new Date().toISOString()
                          })
                        }
                      />
                      <small>Closes when loss reaches this threshold.</small>
                    </label>
                    <label className="se-risk-field">
                      <span>Take Profit %</span>
                      <input
                        type="number"
                        value={draft.riskRules.takeProfitPct ?? ""}
                        placeholder="--"
                        onChange={(ev) =>
                          setDraft({
                            ...cloneStrategy(draft),
                            riskRules: { ...draft.riskRules, takeProfitPct: Number(ev.target.value) },
                            updatedAt: new Date().toISOString()
                          })
                        }
                      />
                      <small>Locks profit once price reaches this gain.</small>
                    </label>
                    <label className="se-risk-field">
                      <span>Trailing Stop %</span>
                      <input
                        type="number"
                        value={draft.riskRules.trailingStopPct ?? ""}
                        placeholder="--"
                        onChange={(ev) =>
                          setDraft({
                            ...cloneStrategy(draft),
                            riskRules: { ...draft.riskRules, trailingStopPct: Number(ev.target.value) },
                            updatedAt: new Date().toISOString()
                          })
                        }
                      />
                      <small>Follows favorable moves, then exits on pullback.</small>
                    </label>
                  </div>
                </div>

                <div className="se-risk-subgroup simulation">
                  <div className="se-risk-subgroup-head">
                    <span className="se-risk-kicker">Simulation</span>
                    <small>Used only for validation and backtest calculations.</small>
                  </div>
                  <div className="se-risk-grid-2">
                    <label className="se-risk-field">
                      <span>Max Bars</span>
                      <input
                        type="number"
                        value={draft.riskRules.maxBarsInTrade ?? ""}
                        placeholder="--"
                        onChange={(ev) =>
                          setDraft({
                            ...cloneStrategy(draft),
                            riskRules: { ...draft.riskRules, maxBarsInTrade: Number(ev.target.value) },
                            updatedAt: new Date().toISOString()
                          })
                        }
                      />
                      <small>Maximum candles a trade can stay open.</small>
                    </label>
                    <label className="se-risk-field">
                      <span>Starting Equity</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={draft.costModel.startingEquity}
                        onChange={(ev) =>
                          setDraft({
                            ...cloneStrategy(draft),
                            costModel: { ...draft.costModel, startingEquity: Number(ev.target.value) },
                            updatedAt: new Date().toISOString()
                          })
                        }
                      />
                      <small>Base capital for simulated performance.</small>
                    </label>
                    <label className="se-risk-field">
                      <span>Fees (bps)</span>
                      <input
                        type="number"
                        value={draft.costModel.feeBps}
                        onChange={(ev) =>
                          setDraft({
                            ...cloneStrategy(draft),
                            costModel: { ...draft.costModel, feeBps: Number(ev.target.value) },
                            updatedAt: new Date().toISOString()
                          })
                        }
                      />
                      <small>Exchange fee per trade. 100 bps equals 1%.</small>
                    </label>
                    <label className="se-risk-field">
                      <span>Slippage (bps)</span>
                      <input
                        type="number"
                        value={draft.costModel.slippageBps}
                        onChange={(ev) =>
                          setDraft({
                            ...cloneStrategy(draft),
                            costModel: { ...draft.costModel, slippageBps: Number(ev.target.value) },
                            updatedAt: new Date().toISOString()
                          })
                        }
                      />
                      <small>Estimated price impact per execution.</small>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* ── REGLAS AVANZADAS (TABS) ── */}
            <div className="se-section">
              <button
                type="button"
                className="se-advanced-toggle"
                onClick={() => setRulesExpanded((c) => !c)}
                aria-expanded={rulesExpanded}
              >
                <div className="se-section-copy">
                  <strong>Trading rules</strong>
                  <small>
                    {rulesExpanded
                      ? "Entry and exit conditions by side."
                      : `${draft.entryRules.long.length + draft.entryRules.short.length} entry blocks, ${draft.exitRules.long.length + draft.exitRules.short.length} exit blocks.`}
                  </small>
                </div>
                <div className="se-rules-summary" aria-hidden="true">
                  <span>{draft.enabledSides.map((s) => formatSideLabel(s)).join(" + ")}</span>
                  <span>{rulesExpanded ? "Hide rules" : "Edit rules"}</span>
                </div>
                <span className={`se-toggle-arrow ${rulesExpanded ? "open" : ""}`} aria-hidden="true">
                  ▾
                </span>
              </button>

              {rulesExpanded && (
                <div className="se-advanced-body">
                  <div className="se-tabs-bar">
                    <div className="se-tabs">
                      {(["long", "short"] as const).map((side) => {
                        const sideEnabled = draft.enabledSides.includes(side);
                        return (
                          <button
                            key={side}
                            type="button"
                            className={`se-tab-btn ${activeSide === side ? `active ${side}` : ""}`}
                            onClick={() => setActiveSide(side)}
                          >
                            <span className="se-tab-dot" />
                            {side === "long" ? "Long Side" : "Short Side"}
                          </button>
                        );
                      })}
                    </div>
                    {!draft.enabledSides.includes(activeSide) && (
                      <span className="se-tab-disabled-note">
                        Enable {formatSideLabel(activeSide)} to configure rules.
                      </span>
                    )}
                  </div>

                  <div className="se-rules-tab-content">
                    {draft.enabledSides.includes(activeSide) ? (
                      <>
                        <RuleBuilder
                          title="Entry Rules"
                          groups={draft.entryRules[activeSide]}
                          capabilities={capabilities}
                          onChange={(next) =>
                            setDraft(setRuleGroups(toManualStrategy(draft), "entryRules", activeSide, next))
                          }
                          onGlobalSync={handleGlobalSync}
                        />
                        <RuleBuilder
                          title="Exit Rules"
                          groups={draft.exitRules[activeSide]}
                          capabilities={capabilities}
                          onChange={(next) =>
                            setDraft(setRuleGroups(toManualStrategy(draft), "exitRules", activeSide, next))
                          }
                          onGlobalSync={handleGlobalSync}
                        />
                      </>
                    ) : (
                      <div className="strategy-empty-state">
                        Enable {formatSideLabel(activeSide)} to configure these rules.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── FOOTER ── */}
            <div className="se-footer">
              <button
                type="button"
                className="se-footer-delete"
                onClick={() => void deleteDraft()}
                disabled={busy !== null}
                title="Delete Strategy"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
              </button>
              <div className="se-footer-spacer" />
              <button
                type="button"
                className="se-footer-secondary"
                onClick={() => void validateDraft()}
                disabled={busy !== null || !isDirty}
              >
                Validate
              </button>
              <button
                type="button"
                className="se-footer-secondary"
                onClick={() => void saveDraft()}
                disabled={busy !== null || !isDirty}
              >
                Save
              </button>
              <button
                type="button"
                className="se-footer-primary"
                onClick={() => void runBacktest()}
                disabled={busy !== null}
              >
                {busy === "running" ? "Running..." : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{marginRight: 6}}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    Run Backtest
                  </>
                )}
              </button>
            </div>
          </>
        )}

        {validation && (
          <div className={`se-validation-banner ${validation.ok ? "ok" : "error"}`}>
            <span className="se-validation-icon">
              {validation.ok ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{color: "rgba(14, 203, 129, 0.8)"}}><polyline points="20 6 9 17 4 12"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{color: "rgba(246, 70, 93, 0.8)"}}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              )}
            </span>
            <div className="se-validation-body">
              <strong className="se-validation-title">
                {validation.ok ? "Validation passed" : "Validation issues"}
              </strong>
              {!validation.ok && (
                <div className="se-validation-list">
                  {validation.issues.slice(0, 8).map((issue) => (
                    <div className="se-validation-list-item" key={`${issue.path}-${issue.code}`}>
                      <span>{issue.path}</span>
                      <small>
                        {issue.message}
                        {issue.suggestion ? ` — ${issue.suggestion}` : ""}
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {status && (
          <div className="se-toast-container">
            <div className="se-toast">
              <span className="se-toast-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              </span>
              {status}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
