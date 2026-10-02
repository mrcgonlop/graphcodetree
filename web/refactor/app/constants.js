// ── Color maps and ordering ──────────────────────────────────────────

export const KIND_COLORS = {
    function: '#7aa2f7',
    method: '#7aa2f7',
    struct: '#9ece6a',
    enum: '#bb9af7',
    enum_variant: '#bb9af7',
    trait: '#f7768e',
    impl_block: '#e0af68',
    module: '#2ac3de',
    constant: '#ff9e64',
    static: '#ff9e64',
    type_alias: '#73daca',
    macro: '#f7768e',
    field: '#565f89',
    file: '#414868',
};

export const EDGE_COLORS = {
    calls: { color: '#7aa2f7', width: 2, style: 'solid', arrow: true },
    defines: { color: '#565f89', width: 1, style: 'dotted', arrow: false },
    contains: { color: '#414868', width: 1.5, style: 'solid', arrow: false },
    imports: { color: '#73daca', width: 1.5, style: 'dashed', arrow: false },
    implements: { color: '#f7768e', width: 2, style: 'dashed', arrow: true },
    data_flow: { color: '#ff9e64', width: 2, style: 'solid', arrow: true },
    references: { color: '#bb9af7', width: 1, style: 'dashed', arrow: false },
    inherits: { color: '#e0af68', width: 1.5, style: 'dotted', arrow: false },
    extends: { color: '#9ece6a', width: 1, style: 'dotted', arrow: false },
};

export const KIND_ORDER = [
    'function', 'method', 'struct', 'enum', 'enum_variant',
    'trait', 'impl_block', 'module', 'type_alias',
    'constant', 'static', 'macro', 'field',
];
