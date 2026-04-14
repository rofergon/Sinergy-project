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

  const activeIndicators = useMemo(
    () => (draft ? extractActiveIndicators(draft, capabilities) : []),
    [draft, capabilities]
  );

  const handleGlobalSync = (prevKey: string, nextOp: StrategyOperand) => {
    setDraft((current) => {
      if (!current) return current;
      const syncGroup = (group: StrategyRuleGroup) => ({
        ...group,
        rules: group.rules.map(rule => ({
          ...rule,
          left: serializeOperandKey(rule.left) === prevKey ? { ...nextOp } : rule.left,
          right: serializeOperandKey(rule.right) === prevKey ? { ...nextOp } : rule.right,
        }))
      });
      return {
        ...current,
        entryRules: {
          long: current.entryRules.long.map(syncGroup),
          short: current.entryRules.short.map(syncGroup),
        },
        exitRules: {
          long: current.exitRules.long.map(syncGroup),
          short: current.exitRules.short.map(syncGroup),
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
                <input
                  type="text"
                  className="se-header-name-input"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...cloneStrategy(draft), name: event.target.value, updatedAt: new Date().toISOString() })
                  }
                  spellCheck={false}
                />
              </div>
              <div className="se-header-chips">
                <span className="se-chip">{selectedMarket?.symbol ?? "--"}</span>
                <span className="se-chip">{formatTimeframe(timeframe)}</span>
                <span className="se-chip">
                  {draft.enabledSides.map((s) => formatSideLabel(s)).join(" + ")}
                </span>
                <span className={`se-chip ${draft.status === "saved" ? "se-chip-ok" : "se-chip-draft"}`}>
                  {draft.status === "saved" ? "Saved" : "Draft"}
                </span>
              </div>
            </div>

            {/* ── INDICADORES ACTIVOS ── */}
            <div className="se-section">
              <div className="se-section-head">
                <div className="se-section-copy">
                  <strong>Active indicators</strong>
                  <small>Parameters for the indicators used in the rules</small>
                </div>
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
                          <span className="se-indicator-dot" />
                          <strong>{entry.label}</strong>
                          <small>{entry.output}</small>
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
                  <small>Automatic exits and execution costs</small>
                </div>
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
                </label>
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
                </label>
              </div>
            </div>

            {/* ── REGLAS AVANZADAS (COLAPSABLE) ── */}
            <div className="se-section">
              <button
                type="button"
                className="se-advanced-toggle"
                onClick={() => setRulesExpanded((c) => !c)}
                aria-expanded={rulesExpanded}
              >
                <div className="se-section-copy">
                  <strong>Trading rules</strong>
                  <small>Entry and exit conditions by side</small>
                </div>
                <span className={`se-toggle-arrow ${rulesExpanded ? "open" : ""}`} aria-hidden="true">
                  ▾
                </span>
              </button>

              {rulesExpanded && (
                <div className="se-advanced-body">
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
                                  ? `Define when to open and close ${formatSideLabel(side).toLowerCase()} positions.`
                                  : `Enable ${formatSideLabel(side)} to edit these rules.`}
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
                                onGlobalSync={handleGlobalSync}
                              />
                              <RuleBuilder
                                title="Exit Rules"
                                groups={draft.exitRules[side]}
                                capabilities={capabilities}
                                onChange={(next) => setDraft(setRuleGroups(cloneStrategy(draft), "exitRules", side, next))}
                                onGlobalSync={handleGlobalSync}
                              />
                            </>
                          ) : (
                            <div className="strategy-empty-state">
                              Enable {formatSideLabel(side)} to configure these rules.
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* ── FOOTER ── */}
            <div className="strategy-panel-footer">
              <button type="button" onClick={() => void validateDraft()} disabled={busy !== null}>
                Validate
              </button>
              <button type="button" onClick={() => void saveDraft()} disabled={busy !== null}>
                Save
              </button>
              <button
                type="button"
                className="strategy-primary-btn"
                onClick={() => void runBacktest()}
                disabled={busy !== null}
              >
                {busy === "running" ? "Running..." : "▶ Run Backtest"}
              </button>
            </div>
          </>
        )}

        {validation && (
          <div className={`strategy-validation ${validation.ok ? "ok" : "error"}`}>
            <strong>{validation.ok ? "✓ Validation passed" : "⚠ Validation issues"}</strong>
            {!validation.ok && (
              <div className="strategy-validation-list">
                {validation.issues.slice(0, 8).map((issue) => (
                  <div key={`${issue.path}-${issue.code}`}>
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
        )}

        {status && <div className="strategy-status-msg">{status}</div>}
      </div>
    </div>
  );
}
