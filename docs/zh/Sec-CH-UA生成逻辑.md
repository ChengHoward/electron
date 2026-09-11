# Sec-CH-UA 生成逻辑

| 项 | 内容 |
|----|------|
| 文档版本 | 1.0 |
| 更新日期 | 2026-07-22 |
| 适用基线 | Chromium `150.0.7871.129`（本仓库 `43-x-y`） |
| 规范 | [UA Client Hints — create arbitrary brands](https://wicg.github.io/ua-client-hints/#create-arbitrary-brands-section) |
| 源码 | `src/components/embedder_support/user_agent_utils.cc` |

本文说明 Chromium / Electron **默认**如何生成请求头 `Sec-CH-UA`（及同源的 `navigator.userAgentData.brands`）。  
与本 fork 的 `setUserAgent(..., { userAgentMetadata })` 覆盖关系见文末，以及 [定制Electron功能说明.md](./定制Electron功能说明.md)。

---

## 1. 结论摘要

- `Sec-CH-UA` **不是随机数**，而是以 **Chrome 主版本号 `seed`** 为种子的确定性算法。
- 同一主版本、同一 branding（2 品牌或 3 品牌）→ **全球同一串** header。
- 主版本变化时，会同时变化：
  1. GREASE 假品牌字符串（`Not…A…Brand`）
  2. GREASE 的版本号（`8` / `99` / `24` 轮换）
  3. 各 brand 在列表中的**顺序**
- **必须区分 2 品牌与 3 品牌**：顺序不同。例如 140：
  - Electron / 裸 Chromium（2 项）：`"Not=A?Brand";v="24", "Chromium";v="140"`
  - Google Chrome（3 项）：`"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"`

---

## 2. 调用链

```text
ElectronBrowserClient::GetUserAgentMetadata()
  └─ embedder_support::GetUserAgentMetadata()
       ├─ brand_version_list      ← GetUserAgentBrandMajorVersionList(seed)
       │                            → 序列化后 = Sec-CH-UA / navigator.userAgentData.brands
       └─ brand_full_version_list ← GetUserAgentBrandFullVersionList(seed)
                                    → Sec-CH-UA-Full-Version-List（高熵，通常需 Accept-CH）
```

低熵头（常默认附带）：`Sec-CH-UA`、`Sec-CH-UA-Mobile`、`Sec-CH-UA-Platform`。  
`Sec-CH-UA` 的值来自 `blink::UserAgentMetadata::SerializeBrandMajorVersionList()`（Structured Headers）。

**seed 来源**：`version_info::GetMajorVersionNumber()`，对应 `chrome/VERSION` 的 `MAJOR`（本仓库当前为 `150`）。

---

## 3. 品牌列表如何组装

入口：`GenerateBrandVersionList(seed, brand, version, output_version_type, additional?)`。

按固定顺序**先放入**向量（尚未打乱）：

| 下标 | 内容 | 条件 |
|------|------|------|
| 0 | GREASE：`GetGreasedUserAgentBrandVersion(seed, …)` | 始终 |
| 1 | `{ "Chromium", version }` | 始终 |
| 2 | `{ brand, version }` | 仅当 `!CHROMIUM_BRANDING` 时；`brand = version_info::GetProductName()`（Google Chrome 构建为 `"Google Chrome"`） |
| 3+ | `additional_brand_version` | 可选附加品牌 |

| 构建类型 | `CHROMIUM_BRANDING` | 列表长度 | 典型场景 |
|----------|---------------------|----------|----------|
| 裸 Chromium / Electron（默认） | `true`（不加入产品品牌） | **2** | 本仓库 Electron |
| Google Chrome | `false`，产品名为 Google Chrome | **3** | 真实 Chrome 浏览器 |
| Edge 等 | 产品品牌为自身名称 | **3** | 第三方 Chromium 壳 |

`version`：

- `Sec-CH-UA` / major list：主版本字符串，如 `"150"`
- Full-Version-List：完整四段版本，如 `"150.0.7871.129"`（GREASE 见下节）

随后调用 `ShuffleBrandList(list, seed)` 打乱。

---

## 4. GREASE 假品牌

函数：`GetGreasedUserAgentBrandVersion(seed, output_version_type)`。

### 4.1 字符表与版本表

```text
greasey_chars     = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"]   // 长度 11
greased_versions  = ["8", "99", "24"]                                         // 长度 3
```

### 4.2 公式

```text
greasey_brand   = "Not" + chars[seed % 11] + "A" + chars[(seed + 1) % 11] + "Brand"
greasey_version = greased_versions[seed % 3]
```

示例：

| seed | chars 下标 | GREASE 品牌 | GREASE 版本 |
|------|------------|-------------|-------------|
| 140 | 140%11=8 → `=`；141%11=9 → `?` | `Not=A?Brand` | 140%3=2 → `24` |
| 150 | 150%11=7 → `;`；151%11=8 → `=` | `Not;A=Brand` | 150%3=0 → `8` |

### 4.3 Full version 扩展

- Major list：GREASE 版本保持 `"8"` / `"99"` / `"24"`
- Full-Version-List：扩展为 `"8.0.0.0"` / `"99.0.0.0"` / `"24.0.0.0"`（单段版本时追加 `.0.0.0`）

目的：防止站点把 brand 列表写成死板解析器（GREASE = Generate Random Extensions And Sustain Extensibility）。

---

## 5. 顺序打乱（Shuffle）

### 5.1 `GetRandomOrder(seed, size)`

返回长度为 `size` 的 `order` 数组。语义：

```text
shuffled[order[i]] = original[i]
```

即：`original[i]` 放到最终列表的第 `order[i]` 位。

#### size == 2（Electron / 裸 Chromium）

```text
order = [seed % 2, (seed + 1) % 2]
```

| seed 奇偶 | order | 结果顺序 |
|-----------|-------|----------|
| 偶数 | `[0, 1]` | GREASE → Chromium |
| 奇数 | `[1, 0]` | Chromium → GREASE |

#### size == 3（Google Chrome 等）

取 6 种排列之一：`orders[seed % 6]`

```text
orders = [
  [0, 1, 2],  // seed % 6 == 0
  [0, 2, 1],  // 1
  [1, 0, 2],  // 2
  [1, 2, 0],  // 3
  [2, 0, 1],  // 4
  [2, 1, 0],  // 5
]
```

原始下标：`0=GREASE`，`1=Chromium`，`2=Google Chrome`。

**140 示例**（`140 % 6 == 2` → `[1, 0, 2]`）：

```text
original[0]=GREASE        → shuffled[1]
original[1]=Chromium      → shuffled[0]
original[2]=Google Chrome → shuffled[2]
→ Chromium, GREASE, Google Chrome
```

#### size == 4

另有 24 种排列表（有附加品牌时）；本仓库默认路径一般用不到。

### 5.2 伪代码

```python
chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"]
vers  = ["8", "99", "24"]
orders3 = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2],
    [1, 2, 0], [2, 0, 1], [2, 1, 0],
]

def grease(seed):
    brand = "Not" + chars[seed % 11] + "A" + chars[(seed + 1) % 11] + "Brand"
    return brand, vers[seed % 3]

def shuffle(items, seed):
    n = len(items)
    if n == 2:
        order = [seed % 2, (seed + 1) % 2]
    elif n == 3:
        order = orders3[seed % 6]
    out = [None] * n
    for i, dest in enumerate(order):
        out[dest] = items[i]
    return out

def sec_ch_ua(seed, product_brand=None):
    g_brand, g_ver = grease(seed)
    items = [(g_brand, g_ver), ("Chromium", str(seed))]
    if product_brand:
        items.append((product_brand, str(seed)))
    return shuffle(items, seed)
```

序列化格式（Structured Headers）：

```text
"Brand";v="Version", "Brand2";v="Version2", ...
```

---

## 6. 版本对照表（120–150）

### 6.1 两项：Electron / 裸 Chromium

| seed | Sec-CH-UA |
|------|-----------|
| 120 | `"Not_A Brand";v="8", "Chromium";v="120"` |
| 121 | `"Chromium";v="121", "Not A(Brand";v="99"` |
| 122 | `"Not(A:Brand";v="24", "Chromium";v="122"` |
| 123 | `"Chromium";v="123", "Not:A-Brand";v="8"` |
| 124 | `"Not-A.Brand";v="99", "Chromium";v="124"` |
| 125 | `"Chromium";v="125", "Not.A/Brand";v="24"` |
| 126 | `"Not/A)Brand";v="8", "Chromium";v="126"` |
| 127 | `"Chromium";v="127", "Not)A;Brand";v="99"` |
| 128 | `"Not;A=Brand";v="24", "Chromium";v="128"` |
| 129 | `"Chromium";v="129", "Not=A?Brand";v="8"` |
| 130 | `"Not?A_Brand";v="99", "Chromium";v="130"` |
| 131 | `"Chromium";v="131", "Not_A Brand";v="24"` |
| 132 | `"Not A(Brand";v="8", "Chromium";v="132"` |
| 133 | `"Chromium";v="133", "Not(A:Brand";v="99"` |
| 134 | `"Not:A-Brand";v="24", "Chromium";v="134"` |
| 135 | `"Chromium";v="135", "Not-A.Brand";v="8"` |
| 136 | `"Not.A/Brand";v="99", "Chromium";v="136"` |
| 137 | `"Chromium";v="137", "Not/A)Brand";v="24"` |
| 138 | `"Not)A;Brand";v="8", "Chromium";v="138"` |
| 139 | `"Chromium";v="139", "Not;A=Brand";v="99"` |
| 140 | `"Not=A?Brand";v="24", "Chromium";v="140"` |
| 141 | `"Chromium";v="141", "Not?A_Brand";v="8"` |
| 142 | `"Not_A Brand";v="99", "Chromium";v="142"` |
| 143 | `"Chromium";v="143", "Not A(Brand";v="24"` |
| 144 | `"Not(A:Brand";v="8", "Chromium";v="144"` |
| 145 | `"Chromium";v="145", "Not:A-Brand";v="99"` |
| 146 | `"Not-A.Brand";v="24", "Chromium";v="146"` |
| 147 | `"Chromium";v="147", "Not.A/Brand";v="8"` |
| 148 | `"Not/A)Brand";v="99", "Chromium";v="148"` |
| 149 | `"Chromium";v="149", "Not)A;Brand";v="24"` |
| **150** | **`"Not;A=Brand";v="8", "Chromium";v="150"`** |

### 6.2 三项：Google Chrome

| seed | Sec-CH-UA |
|------|-----------|
| 120 | `"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"` |
| 121 | `"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"` |
| 122 | `"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"` |
| 123 | `"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"` |
| 124 | `"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"` |
| 125 | `"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"` |
| 126 | `"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"` |
| 127 | `"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"` |
| 128 | `"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"` |
| 129 | `"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"` |
| 130 | `"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"` |
| 131 | `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"` |
| 132 | `"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"` |
| 133 | `"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"` |
| 134 | `"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"` |
| 135 | `"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"` |
| 136 | `"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"` |
| 137 | `"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"` |
| 138 | `"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"` |
| 139 | `"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"` |
| **140** | **`"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"`** |
| 141 | `"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"` |
| 142 | `"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"` |
| 143 | `"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"` |
| 144 | `"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"` |
| 145 | `"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"` |
| 146 | `"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"` |
| 147 | `"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"` |
| 148 | `"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"` |
| 149 | `"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"` |
| **150** | **`"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"`** |

> Edge / Brave 等：把第三项品牌名换成自身名称，**顺序与 GREASE 仍按同一 seed 算法**（与 Chrome 三项表同构）。

---

## 7. 与本仓库定制 API 的关系

默认路径走上文算法。本 fork 的 `setUserAgent` 可覆盖：

| `userAgentMetadata` | `Sec-CH-UA*` 行为 |
|---------------------|-------------------|
| 省略 | 使用构建默认 metadata（上文算法） |
| `null` | **不发送** `Sec-CH-UA-*` |
| 对象且含 `brands` | **直接使用**你提供的列表，**不再跑 GREASE / Shuffle** |
| 对象但未给 `brands` | 未给字段由默认 metadata 填充 |

伪装成真实 Chrome 时，应提供与目标主版本一致的 **三项** `brands`（含正确 GREASE 字符串、版本与顺序），并保证：

- UA 字符串中的 Chrome 主版本
- `userAgentMetadata.brands` / `fullVersionList`
- `userAgentMetadata.platform` 等

彼此一致。详见 [定制Electron功能说明.md](./定制Electron功能说明.md) §3.1 / §4.2。

---

## 8. 源码索引

| 符号 / 文件 | 作用 |
|-------------|------|
| `GetUserAgentMetadata` | 组装完整 UA-CH metadata |
| `GetUserAgentBrandMajorVersionList` | 生成 major brand 列表 → `Sec-CH-UA` |
| `GetUserAgentBrandFullVersionList` | 生成 full brand 列表 |
| `GenerateBrandVersionList` | 组装 + shuffle |
| `GetGreasedUserAgentBrandVersion` | GREASE 品牌 / 版本 |
| `GetRandomOrder` / `ShuffleBrandList` | 确定性打乱 |
| `UserAgentMetadata::SerializeBrandVersionList` | Structured Headers 序列化 |
| `user_agent_utils_unittest.cc` | 单测（如 seed=84/85 期望值） |
| `electron/.../user_agent_options.*` | 本 fork 解析自定义 metadata |

---

## 9. 参考

- 规范：[UA-CH create arbitrary brands](https://wicg.github.io/ua-client-hints/#create-arbitrary-brands-section)
- Chromium 实现：`components/embedder_support/user_agent_utils.cc`
- 本仓库当前 `chrome/VERSION`：`MAJOR=150`
