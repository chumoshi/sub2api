# 计费系统分析文档

> 本文档基于源码分析，所有结论均附有具体文件路径与行号，不含推测性内容。

---

## 一、计费货币单位

**全系统统一使用 USD（美元），无汇率换算逻辑。**

| 证据 | 来源 |
|------|------|
| API Key 配额注释：`Quota limit in USD (0 = unlimited)` | `backend/internal/service/api_key.go:49` |
| 分组限额字段：`DailyLimitUSD`、`WeeklyLimitUSD`、`MonthlyLimitUSD` | `backend/internal/repository/api_key_repo.go:703-705` |
| 订阅用量函数参数名：`costUSD`，数据库列：`daily_usage_usd` | `backend/internal/repository/user_subscription_repo.go:342,346` |
| 分组限额 ent schema 字段：`daily_limit_usd` | `backend/internal/repository/group_repo.go:49-51` |

---

## 二、计费触发时机

每次 API 请求完成（收到上游响应）后触发，入口为 `recordUsageCore`。

```
API请求 → 转发上游 → 解析 token 用量 → 计算费用 → 写入使用日志 + 扣款
```

> 来源：`backend/internal/service/gateway_service.go:8432`

---

## 三、三种计费模式

计费模式（`BillingMode`）由渠道定价配置决定，在 `CalculateCostUnified` 中分发：

| 模式 | 说明 |
|------|------|
| `token` | 按 Token 数量计费（默认） |
| `per_request` | 按请求次数计费（固定单价） |
| `image` | 按图片数量+尺寸计费 |

> 来源：`backend/internal/service/billing_service.go:416,438-451`，`backend/internal/service/model_pricing_resolver.go:8-13`

---

## 四、Token 模式费用计算公式

### 4.1 费用组成

```
TotalCost =
    InputTokens         × InputPrice
  + TextOutputTokens    × OutputPrice
  + ImageOutputTokens   × ImageOutputPrice
  + CacheCreationTokens × CacheCreationPrice   （或按 5m/1h 分类）
  + CacheReadTokens     × CacheReadPrice
```

> 来源：`backend/internal/service/billing_service.go:507-540`

### 4.2 实际扣费额

```
ActualCost = TotalCost × RateMultiplier
```

> 来源：`backend/internal/service/billing_service.go:540`

### 4.3 缓存创建分类计费（5m / 1h）

当模型定价中 `SupportsCacheBreakdown=true` 且存在 `CacheCreation1hPrice > CacheCreation5mPrice` 时，缓存创建按实际 TTL 分类计费：

- `CacheCreation5mTokens × CacheCreation5mPrice`
- `CacheCreation1hTokens × CacheCreation1hPrice`

否则，统一按 `CacheCreationPricePerToken` 计费。

> 来源：`backend/internal/service/billing_service.go:546-556`

---

## 五、费率倍率（RateMultiplier）优先级

优先级从高到低依次为：

```
1. 用户专属分组倍率   （user_group_rate_multipliers 表）
2. 分组默认倍率       （group.RateMultiplier）
3. 系统全局默认倍率   （config.Default.RateMultiplier）
```

> 来源：`backend/internal/service/gateway_service.go:8460-8464`

用户专属倍率通过 `getUserGroupRateMultiplier` 解析，实现在 `backend/internal/repository/user_group_rate_repo.go`。

---

## 六、ServiceTier 额外倍率

仅在无独立 priority 定价时生效，作为全局乘数追加到 `TotalCost` 各分项上：

| ServiceTier | 倍率 |
|-------------|------|
| `priority` | ×2.0 |
| `flex` | ×0.5 |
| 默认（空） | ×1.0 |

若模型存在独立的 `InputPricePerTokenPriority` 等 priority 专属价格，则直接替换基础单价，不再叠加倍率。

> 来源：`backend/internal/service/billing_service.go:79-88`，`billing_service.go:485-498`

---

## 七、长上下文定价（特殊策略）

当总输入 token（InputTokens + CacheReadTokens）超过阈值时，触发整次会话的价格倍率提升：

| 参数 | GPT-5.4 默认值 |
|------|---------------|
| 触发阈值 | 272,000 tokens |
| 输入价格倍率 | ×2.0 |
| 输出价格倍率 | ×1.5 |

该策略通过 `shouldApplySessionLongContextPricing` 判断，仅在无区间定价（`Intervals` 为空）时生效，因为区间定价已自含上下文分层。

> 来源：`backend/internal/service/billing_service.go:63-65`，`billing_service.go:501-503`，`billing_service.go:638-647`

---

## 八、定价数据来源（三级查找链）

由 `ModelPricingResolver.Resolve` 统一解析，优先级如下：

```
1. 渠道自定义价格（channel_model_pricing 表）→ 完全覆盖
2. LiteLLM 动态价格（从远端定期同步的 JSON 文件）
3. 硬编码回退价格（billing_service.go 内置，按模型系列模糊匹配）
```

> 来源：`backend/internal/service/model_pricing_resolver.go:10-12`，`model_pricing_resolver.go:63-101`，`model_pricing_resolver.go:104-112`

### 内置回退价格示例

| 模型系列 | 输入价格 | 输出价格 |
|---------|---------|---------|
| Claude Opus 4.5 | $5/MTok | $25/MTok |
| Claude Sonnet 4 | $3/MTok | $15/MTok |
| Claude 3.5 Haiku | $1/MTok | $5/MTok |
| GPT-5.4 | $2.5/MTok | $15/MTok |

> 来源：`backend/internal/service/billing_service.go:140-261`

---

## 九、两种计费方式

由 `apiKey.Group.IsSubscriptionType()` 判断当前分组是否为订阅类型：

| 方式 | 常量值 | 触发条件 | 操作 |
|------|--------|---------|------|
| 余额扣款 | `BillingTypeBalance = 0` | 普通余额分组 | `userRepo.DeductBalance(ActualCost)` |
| 订阅计量 | `BillingTypeSubscription = 1` | 订阅类型分组且用户有有效订阅 | `userSubRepo.IncrementUsage(ActualCost)` |

两种方式均操作 `ActualCost`（即含 RateMultiplier 的最终金额）。

> 来源：`backend/internal/service/usage_log.go:10-11`，`gateway_service.go:8487-8490`，`gateway_service.go:8008-8014`

---

## 十、API Key 配额与速率限制

完成扣款后，若 API Key 配置了配额或速率限制，同步更新对应计数器：

- **配额**：`APIKeyService.UpdateQuotaUsed(apiKeyID, ActualCost)`（`gateway_service.go:8021`）
- **速率限制**：`APIKeyService.UpdateRateLimitUsage(apiKeyID, ActualCost)`（`gateway_service.go:8027`），支持 5h / 1d / 7d 三个滑动窗口（`billing_service.go:13-21`）

---

## 十一、事务安全与幂等性

使用日志写入与余额扣款在同一个数据库事务中执行，保证原子性，防止重复扣费或漏扣：

```go
tx := s.entClient.Tx(ctx)
// 写入使用日志
// 扣除用户余额
tx.Commit()
```

> 来源：`backend/internal/service/usage_service.go:76-133`

---

## 十二、对接 OpenRouter 等三方厂商时的定价行为

**系统按「计费模型名」在内部查价，与上游厂商实际收取的费用无关。**

### 计费模型名来源（`BillingModelSource`）

渠道通过 `BillingModelSource` 字段控制使用哪个名称查价：

| 值 | 含义 |
|----|------|
| `channel_mapped`（**默认**） | 渠道映射后的模型名 |
| `requested` | 客户端原始请求的模型名 |
| `upstream` | 上游响应实际返回的模型名 |

默认值为 `channel_mapped`，在 `normalizeBillingModelSource` 中回填。

> 来源：`backend/internal/service/channel.go:29-31`，`channel.go:117,121-122`

### 潜在差价问题

LiteLLM 定价数据来自各厂商官方价格。OpenRouter 等三方厂商会在官方价格基础上加价（markup），但系统**不感知**这层差价：

```
实际付给 OpenRouter 的费用  ≠  系统计算的 ActualCost
```

### 解决方式

1. **渠道自定义价格**：在 `channel_model_pricing` 表中为该渠道+模型配置实际价格，渠道价格优先级最高，会完全覆盖 LiteLLM 价格。（来源：`model_pricing_resolver.go:63-80`）
2. **调高 RateMultiplier**：在分组层面整体放大倍率，间接弥补差价（粗粒度）。（来源：`gateway_service.go:8460-8464`）

---

## 附：计费流程总览

```
请求到达
    │
    ▼
recordUsageCore (gateway_service.go:8432)
    │
    ├─ 解析 token 用量（ForceCacheBilling / CacheTTLOverride）
    │
    ├─ 确定 RateMultiplier
    │     用户专属 > 分组默认 > 系统默认 (gateway_service.go:8460-8464)
    │
    ├─ 确定计费模型名 (BillingModelSource: channel_mapped/requested/upstream)
    │
    ├─ CalculateCostUnified (billing_service.go:416)
    │     └─ ModelPricingResolver.Resolve
    │           渠道价格 > LiteLLM > Fallback (model_pricing_resolver.go:63)
    │
    ├─ 判断计费方式 (gateway_service.go:8487)
    │     IsSubscriptionType → BillingTypeSubscription
    │     否则              → BillingTypeBalance
    │
    └─ applyUsageBilling (gateway_service.go:8132)
          ├─ 订阅：IncrementUsage(ActualCost)
          ├─ 余额：DeductBalance(ActualCost)
          ├─ API Key 配额：UpdateQuotaUsed(ActualCost)
          └─ API Key 速率：UpdateRateLimitUsage(ActualCost)
```
