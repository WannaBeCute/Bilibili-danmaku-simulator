## JSON格式设计说明

### 一、为什么这样设计？

这个JSON结构的设计目标是**完整保留B站高级弹幕的所有参数**，同时**清晰分类**便于编辑和渲染。

---

### 二、完整转换逻辑

```javascript
/**
 * XML高级弹幕 → 本地JSON格式
 * 
 * 输入: <d p="...">[数组]</d>
 * 输出: 上述JSON结构
 */
function convertAdvancedDanmaku(xmlContent, pParams, index) {
    // ===== 第1步：解析XML的p参数 =====
    const p = pParams.split(',');
    const time = parseFloat(p[0]);          // 出现时间（秒）
    const mode = parseInt(p[1]);            // 7=高级弹幕
    const fontSize = parseInt(p[2]);        // 字号（来自p参数，作为备用）
    const colorDecimal = parseInt(p[3]);    // 颜色（十进制）
    const uidHash = p[6];                   // 用户HASH
    
    // ===== 第2步：解析高级弹幕的JSON数组 =====
    const data = JSON.parse(xmlContent);
    // data = [startX, startY, "透明度", 生存时间, "内容", Z轴, Y轴, endX, endY, 运动耗时, 延迟, 线性加速, "字体", 未知]
    
    // ===== 第3步：从content文本中提取精确参数 =====
    const contentText = data[4] || '';
    const extracted = extractParamsFromContent(contentText);
    
    // ===== 第4步：组装JSON =====
    return {
        // ===== 基础信息 =====
        id: generateId(index),              // 唯一标识
        sender: uidHash ? '用户_' + uidHash.slice(0, 8) : '用户',
        type: 'advanced',                   // 固定为高级弹幕
        
        // ===== 内容与时间 =====
        content: contentText,               // 显示的文字
        time: formatTime(time),             // 出现时间（hh:mm:ss）
        
        // ===== 外观样式 =====
        style: {
            // 优先级：content提取 > 数组第12项 > p参数
            color: extracted.color || convertColor(colorDecimal),
            fontSize: extracted.fontSize || data[12]?.match(/\d+/)?.[0] || fontSize,
            fontFamily: extracted.fontFamily || data[12]?.replace(/"/g, '') || 'SimHei',
            stroke: extracted.stroke || false
        },
        
        // ===== 空间旋转 =====
        rotation: {
            z: extracted.rotationZ ?? data[5] ?? 0,
            y: extracted.rotationY ?? data[6] ?? 0
        },
        
        // ===== 生命周期 =====
        life: {
            duration: extracted.duration ?? data[3] ?? 4.5,
            opacityStart: extracted.opacityStart ?? parseFloat(data[2].split('-')[0]) ?? 1,
            opacityEnd: extracted.opacityEnd ?? parseFloat(data[2].split('-')[1]) ?? 1
        },
        
        // ===== 运动轨迹 =====
        motion: {
            moveDuration: extracted.moveDuration ?? data[9] ?? 500,
            delay: extracted.delay ?? data[10] ?? 0,
            linear: extracted.linear ?? (data[11] === 1),
            type: 'position'                // 固定为起始位置模式
        },
        
        // ===== 坐标定位 =====
        position: {
            usePercent: false,              // XML都是像素坐标
            startX: extracted.startX ?? data[0] ?? 0,
            startY: extracted.startY ?? data[1] ?? 0,
            endX: extracted.endX ?? data[7] ?? 0,
            endY: extracted.endY ?? data[8] ?? 0
        }
    };
}

/**
 * 从content文本中提取参数
 * 示例: "字体大小50 颜色#FE0302 Z轴翻转57 Y轴翻转56 ..."
 */
function extractParamsFromContent(text) {
    const result = {};
    
    // 颜色: #FE0302
    const colorMatch = text.match(/#([0-9A-Fa-f]{6})/);
    if (colorMatch) result.color = '#' + colorMatch[1];
    
    // 字体大小: 字体大小50
    const sizeMatch = text.match(/字体大小(\d+)/);
    if (sizeMatch) result.fontSize = parseInt(sizeMatch[1]);
    
    // 字体: 文本字体 微软雅黑
    const fontMatch = text.match(/文本字体\s*([^\s]+)/);
    if (fontMatch) result.fontFamily = fontMatch[1];
    
    // 描边: 文字描边 开/关
    if (text.includes('文字描边 开')) result.stroke = true;
    else if (text.includes('文字描边 关')) result.stroke = false;
    
    // Z轴旋转: Z轴翻转57 或 Z轴翻转 57
    const rotZMatch = text.match(/Z轴翻转\s*([\d.]+)/);
    if (rotZMatch) result.rotationZ = parseFloat(rotZMatch[1]);
    
    // Y轴旋转
    const rotYMatch = text.match(/Y轴翻转\s*([\d.]+)/);
    if (rotYMatch) result.rotationY = parseFloat(rotYMatch[1]);
    
    // 生存时间
    const durMatch = text.match(/生存时间\s*([\d.]+)/);
    if (durMatch) result.duration = parseFloat(durMatch[1]);
    
    // 透明度
    const opMatch = text.match(/衰弱透明度\s*([\d.]+)~([\d.]+)/);
    if (opMatch) {
        result.opacityStart = parseFloat(opMatch[1]);
        result.opacityEnd = parseFloat(opMatch[2]);
    }
    
    // 运动耗时
    const moveMatch = text.match(/运动耗时([\d.]+)/);
    if (moveMatch) result.moveDuration = parseFloat(moveMatch[1]);
    
    // 延迟时间
    const delayMatch = text.match(/延迟时间\s*([\d.]+)/);
    if (delayMatch) result.delay = parseFloat(delayMatch[1]);
    
    // 线性加速
    if (text.includes('线性加速 开')) result.linear = true;
    else if (text.includes('线性加速 关')) result.linear = false;
    
    // 起始位置: 起始位置 (289,204)
    const startMatch = text.match(/起始位置\s*\(([\d.]+)\s*,\s*([\d.]+)\)/);
    if (startMatch) {
        result.startX = parseFloat(startMatch[1]);
        result.startY = parseFloat(startMatch[2]);
    }
    
    // 结束位置
    const endMatch = text.match(/结束位置\s*\(([\d.]+)\s*,\s*([\d.]+)\)/);
    if (endMatch) {
        result.endX = parseFloat(endMatch[1]);
        result.endY = parseFloat(endMatch[2]);
    }
    
    return result;
}

/**
 * 颜色转换: 十进制 → #FFFFFF
 */
function convertColor(decimal) {
    return '#' + decimal.toString(16).padStart(6, '0').toUpperCase();
}

/**
 * 时间格式化: 秒 → hh:mm:ss
 */
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 生成唯一ID
 */
function generateId(index) {
    return 'd' + String(index + 1).padStart(4, '0');
}
```

---

### 三、字段映射对照表

| XML数组 | JSON路径 | 数据来源 | 理由 |
|---------|----------|----------|------|
| 数组[0] | `position.startX` | 优先从content提取，否则用数组值 | content更准确 |
| 数组[1] | `position.startY` | 同上 | 同上 |
| 数组[2] | `life.opacityStart/End` | 数组值 | 唯一来源 |
| 数组[3] | `life.duration` | 优先从content提取，否则用数组值 | content可能包含更精确的值 |
| 数组[4] | `content` | 数组值 | 弹幕正文 |
| 数组[5] | `rotation.z` | 优先从content提取，否则用数组值 | content描述更清晰 |
| 数组[6] | `rotation.y` | 同上 | 同上 |
| 数组[7] | `position.endX` | 优先从content提取，否则用数组值 | content更准确 |
| 数组[8] | `position.endY` | 同上 | 同上 |
| 数组[9] | `motion.moveDuration` | 优先从content提取，否则用数组值 | 同上 |
| 数组[10] | `motion.delay` | 同上 | 同上 |
| 数组[11] | `motion.linear` | 同上 | 同上 |
| 数组[12] | `style.fontFamily` | 优先从content提取，否则用数组值 | content可能包含"微软雅黑"等 |
| p[0] | `time` | p参数 | 唯一来源 |
| p[1] | `type` | p参数 | 判断是否为高级弹幕 |
| p[2] | `style.fontSize` | p参数 | 备用，content优先 |
| p[3] | `style.color` | p参数 | 备用，content优先 |
| p[6] | `sender` | p参数 | 用户标识 |

---

### 四、为什么用这些字段名？

| 字段 | 命名理由 |
|------|----------|
| `style` | 直观表示外观相关参数 |
| `rotation` | 明确表示空间旋转 |
| `life` | 表示弹幕的生命周期 |
| `motion` | 表示运动相关参数 |
| `position` | 表示坐标定位 |
| `usePercent` | 预留百分比坐标支持 |
| `stroke` | 描边，B站高级弹幕常见参数 |

---

### 五、转换优先级规则

```
1. content文本提取 → 最优先（因为用户可能在文本中修改了参数）
2. JSON数组值 → 次优先（B站原始数据）
3. p参数值 → 兜底（保证有默认值）
```

---

### 六、完整转换示例

**输入（XML高级弹幕）：**
```xml
<d p="2.00000,7,50,16646914,1785734740,0,81deae14,2169659274077628160,2">[289,204,"1-0.1",6.66,"弹幕颜色#FE0302 字体大小50 文本字体 微软雅黑 Z轴 57 Y轴 56 生存时间 6.66 衰弱透明度 1~0.1 运动耗时8000 延迟时间（毫秒） 1000 运动方式 起始位置 弹幕坐标 X1 289 Y1 204 X2 507 Y2 339 弹幕出现时间 00:00:02",57,56,507,339,8000,1000,1,"Microsoft YaHei",1]</d>
```

**输出（JSON）：**
```json
{
  "id": "d0001",
  "sender": "用户_81deae14",
  "type": "advanced",
  "content": "弹幕颜色#FE0302 字体大小50 文本字体 微软雅黑 Z轴 57 Y轴 56 生存时间 6.66 衰弱透明度 1~0.1 运动耗时8000 延迟时间（毫秒） 1000 运动方式 起始位置 弹幕坐标 X1 289 Y1 204 X2 507 Y2 339 弹幕出现时间 00:00:02",
  "time": "00:00:02",
  "style": {
    "color": "#FE0302",
    "fontSize": 50,
    "fontFamily": "微软雅黑",
    "stroke": false
  },
  "rotation": {
    "z": 57,
    "y": 56
  },
  "life": {
    "duration": 6.66,
    "opacityStart": 1,
    "opacityEnd": 0.1
  },
  "motion": {
    "moveDuration": 8000,
    "delay": 1000,
    "linear": true,
    "type": "position"
  },
  "position": {
    "usePercent": false,
    "startX": 289,
    "startY": 204,
    "endX": 507,
    "endY": 339
  }
}
```

---

### 七、为什么优先从content提取？

1. **用户修改**：用户在编辑器中修改后，`content`文本中的参数描述会更新
2. **可读性**：`content`中的描述是人类可读的，如"字体大小50"比数组中的数字更明确
3. **一致性**：当数组值和文本描述不一致时，文本描述更可能是用户想要的
4. **冗余**：即使数组解析失败，从文本中也能提取到大部分参数

---

### 八、设计哲学

```
1. 完整保留：不丢失任何原始数据
2. 清晰分类：按功能模块分组，便于编辑
3. 优先用户输入：content > 数组 > p参数
4. 向后兼容：新增字段不影响旧数据
5. 类型明确：每个字段都有明确的类型和范围
```