window.SHOWME = {
  skin: 'soft',
  kicker: '方案对比',
  title: '三条路，打分摊开看',
  lead: '同一张表里比：改动量越小越好，风险越小越好，收益越大越好。**倾向**标在 A 上。',
  meta: ['3 个方案 × 3 个维度', 'matrix 块'],
  sections: [
    {
      heading: '打分',
      sub: '0–5 分，越高越多',
      sectionReceipt: false,
      blocks: [
        {
          type: 'matrix',
          scoreMax: 5,
          head: ['改动量', '风险', '收益'],
          rows: [
            { label: 'A · 只改词表', scores: [2, 3, 2], best: true, note: '一行字段就够，最省' },
            { label: 'B · 独立形状', scores: [5, 4, 4], note: '要动四份骨架与新测试' },
            { label: 'C · 决策矩阵块', scores: ['—', 2, 5], note: '改动量与 A 不可比，这一维不适用' },
          ],
          summary: '先做 A：改动最小、收益够用；B 等第二个用例真出现再动',
        },
        { type: 'callout', label: '倾向', text: 'A 不是最优解，是**最便宜的那一步**。C 的收益最高，但它要等 A 铺好路。' },
      ],
    },
    {
      heading: '代价与取舍',
      sub: '数字之外的账',
      sectionReceipt: false,
      blocks: [
        {
          type: 'kv',
          pairs: [
            ['A 的代价', '只覆盖全页共用词表，条目之间仍然同词'],
            ['B 的代价', '四份骨架 + 宿主校验 + 测试全要动'],
            ['C 的代价', '新块类型 + 校验 + 文档，收益要 8 条以上才显出来'],
          ],
        },
        { type: 'text', text: '刻度只回答“哪个便宜”，**回答不了“该不该做”** —— 那一句还是得人写。' },
      ],
    },
  ],
  verdicts: ['同意', '要改', '不要'],
}
