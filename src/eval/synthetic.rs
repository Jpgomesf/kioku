//! Synthetic distractor notes for the scale benchmark.
//!
//! Each note reads like a platform team's decision about one of 400 systems
//! the graded queries never ask about, in English or Portuguese, with error
//! codes, settings, metrics, and commands. Notes link to earlier notes about
//! the same system and now and then to another system, so the link graph
//! grows with the corpus. No label equals a graded query, so exact matches
//! still belong to the dataset's own notes. Note `i` is the same whatever the
//! corpus size, so a larger corpus extends a smaller one.

use crate::model::NoteInput;

use super::graph::Rng;

/// Names the generator's output. Change it whenever the text changes, so
/// storage prepared by an older generator is rebuilt instead of reused.
pub const GENERATOR: &str = "distractors-v1";

const SEED: u64 = 0x6B69_6F6B_7573_6361;

const SYSTEMS: [&str; 40] = [
    "ledger",
    "invoice",
    "catalog",
    "geo",
    "pricing",
    "inventory",
    "notify",
    "payroll",
    "fraud",
    "loyalty",
    "quote",
    "tax",
    "shipping",
    "refund",
    "coupon",
    "survey",
    "calendar",
    "document",
    "contract",
    "kyc",
    "chat",
    "audit",
    "report",
    "export",
    "batch-import",
    "webhook",
    "scheduler",
    "usage-metrics",
    "consent",
    "address",
    "currency",
    "voucher",
    "referral",
    "warehouse",
    "routing",
    "translation",
    "pdf",
    "sms",
    "email",
    "partner",
];

const KINDS: [&str; 10] = [
    "api", "worker", "sync", "gateway", "store", "bridge", "router", "cron", "proxy", "relay",
];

/// Systems in the corpus: every system name with every kind.
const SYSTEM_COUNT: usize = SYSTEMS.len() * KINDS.len();

struct Aspect {
    slug: &'static str,
    en: &'static str,
    pt: &'static str,
    tag: &'static str,
    /// Templates that state this aspect's decision; one always opens the body.
    templates: &'static [usize],
}

const ASPECTS: [Aspect; 20] = [
    Aspect {
        slug: "retry-policy",
        en: "retry policy",
        pt: "política de novas tentativas",
        tag: "reliability",
        templates: &[0, 13],
    },
    Aspect {
        slug: "timeouts",
        en: "timeouts",
        pt: "tempos limite",
        tag: "reliability",
        templates: &[13, 0],
    },
    Aspect {
        slug: "alert-thresholds",
        en: "alert thresholds",
        pt: "limiares de alerta",
        tag: "observability",
        templates: &[2, 11],
    },
    Aspect {
        slug: "data-retention",
        en: "data retention",
        pt: "retenção de dados",
        tag: "data",
        templates: &[3, 12],
    },
    Aspect {
        slug: "deploy-checklist",
        en: "deploy checklist",
        pt: "checklist de deploy",
        tag: "release",
        templates: &[4, 5],
    },
    Aspect {
        slug: "oncall-runbook",
        en: "on-call runbook",
        pt: "runbook de plantão",
        tag: "operations",
        templates: &[5, 11],
    },
    Aspect {
        slug: "error-codes",
        en: "error codes",
        pt: "códigos de erro",
        tag: "api",
        templates: &[6, 0],
    },
    Aspect {
        slug: "capacity-limits",
        en: "capacity limits",
        pt: "limites de capacidade",
        tag: "limits",
        templates: &[7, 12],
    },
    Aspect {
        slug: "storage-choice",
        en: "storage choice",
        pt: "escolha de armazenamento",
        tag: "architecture",
        templates: &[8, 3],
    },
    Aspect {
        slug: "read-replicas",
        en: "read replicas",
        pt: "réplicas de leitura",
        tag: "database",
        templates: &[9, 8],
    },
    Aspect {
        slug: "nightly-jobs",
        en: "nightly jobs",
        pt: "jobs noturnos",
        tag: "scheduling",
        templates: &[10, 12],
    },
    Aspect {
        slug: "ownership",
        en: "ownership",
        pt: "responsáveis",
        tag: "teams",
        templates: &[11, 4],
    },
    Aspect {
        slug: "batching",
        en: "batching",
        pt: "processamento em lote",
        tag: "performance",
        templates: &[12, 7],
    },
    Aspect {
        slug: "circuit-breaker",
        en: "circuit breaker",
        pt: "disjuntor",
        tag: "reliability",
        templates: &[13, 6],
    },
    Aspect {
        slug: "schema-migrations",
        en: "schema migrations",
        pt: "migrações de esquema",
        tag: "database",
        templates: &[14, 4],
    },
    Aspect {
        slug: "cache-invalidation",
        en: "cache invalidation",
        pt: "invalidação de cache",
        tag: "caching",
        templates: &[15, 9],
    },
    Aspect {
        slug: "access-control",
        en: "access control",
        pt: "controle de acesso",
        tag: "security",
        templates: &[16, 5],
    },
    Aspect {
        slug: "cost-budget",
        en: "cost budget",
        pt: "orçamento de custos",
        tag: "finance",
        templates: &[17, 8],
    },
    Aspect {
        slug: "load-testing",
        en: "load testing",
        pt: "testes de carga",
        tag: "performance",
        templates: &[18, 7],
    },
    Aspect {
        slug: "incident-review",
        en: "incident review",
        pt: "revisão de incidente",
        tag: "operations",
        templates: &[19, 2],
    },
];

const QUALIFIERS: [(&str, &str); 8] = [
    ("staging", "homologação"),
    ("production", "produção"),
    ("EU region", "região UE"),
    ("batch path", "fluxo em lote"),
    ("v3 API", "API v3"),
    ("mobile clients", "clientes móveis"),
    ("partner traffic", "tráfego de parceiros"),
    ("internal tools", "ferramentas internas"),
];

const STORES: [&str; 10] = [
    "Redis",
    "PostgreSQL",
    "S3",
    "Kafka",
    "RabbitMQ",
    "ClickHouse",
    "DynamoDB",
    "Elasticsearch",
    "BigQuery",
    "Memcached",
];

const TEAMS: [(&str, &str); 10] = [
    ("payments", "pagamentos"),
    ("growth", "crescimento"),
    ("data platform", "plataforma de dados"),
    ("core infrastructure", "infraestrutura"),
    ("mobile", "mobile"),
    ("partner integrations", "integrações"),
    ("identity", "identidade"),
    ("finance tooling", "ferramentas financeiras"),
    ("logistics", "logística"),
    ("support tooling", "ferramentas de suporte"),
];

const DATA: [(&str, &str); 8] = [
    ("raw request logs", "os logs brutos de requisição"),
    ("signed documents", "os documentos assinados"),
    ("delivery receipts", "os recibos de entrega"),
    ("customer exports", "as exportações de clientes"),
    ("pricing snapshots", "os snapshots de preço"),
    ("webhook payloads", "os payloads de webhook"),
    ("audit events", "os eventos de auditoria"),
    ("session traces", "os rastros de sessão"),
];

const SETTINGS: [&str; 10] = [
    "retry_backoff_ms",
    "batch_size",
    "max_inflight",
    "pool_size",
    "ttl_seconds",
    "page_size",
    "flush_interval_ms",
    "idle_timeout_s",
    "max_attempts",
    "window_minutes",
];

const CODE_PREFIXES: [&str; 8] = ["ERR", "OPS", "INC", "PLAT", "SEC", "DATA", "SYNC", "GW"];

const REGIONS: [&str; 4] = ["eu-west-1", "us-east-1", "sa-east-1", "ap-southeast-2"];

const DAYS: [(&str, &str); 5] = [
    ("Monday", "segunda-feira"),
    ("Wednesday", "quarta-feira"),
    ("Thursday", "quinta-feira"),
    ("Friday", "sexta-feira"),
    ("Sunday", "domingo"),
];

const VERBS: [(&str, &str, &str); 6] = [
    (
        "drain",
        "drain traffic before maintenance",
        "drenar o tráfego antes da manutenção",
    ),
    (
        "rotate-keys",
        "rotate its signing keys",
        "rotacionar as chaves de assinatura",
    ),
    (
        "replay",
        "replay failed deliveries",
        "reprocessar as entregas que falharam",
    ),
    (
        "rebuild",
        "rebuild its read model",
        "reconstruir o modelo de leitura",
    ),
    (
        "pause",
        "pause consumers during an incident",
        "pausar os consumidores durante um incidente",
    ),
    (
        "reconcile",
        "reconcile totals with the ledger",
        "conciliar os totais com o razão",
    ),
];

const REASONS: [(&str, &str); 6] = [
    (
        "the upstream quota is exhausted",
        "a cota do fornecedor acabou",
    ),
    (
        "the payload failed schema validation",
        "o payload falhou na validação de esquema",
    ),
    ("the tenant is suspended", "o tenant está suspenso"),
    (
        "a duplicate idempotency key was sent",
        "uma chave de idempotência repetida foi enviada",
    ),
    (
        "the partner endpoint timed out",
        "o endpoint do parceiro estourou o tempo",
    ),
    (
        "the signature is older than five minutes",
        "a assinatura tem mais de cinco minutos",
    ),
];

const ADVICE: [(&str, &str); 4] = [
    (
        "back off and retry with jitter",
        "esperar e tentar de novo com jitter",
    ),
    (
        "refresh the token and resend once",
        "renovar o token e reenviar uma vez",
    ),
    (
        "drop the request and alert support",
        "descartar a requisição e avisar o suporte",
    ),
    (
        "fix the payload and send it again",
        "corrigir o payload e enviar de novo",
    ),
];

/// The distractor note at `index`, in `domain`.
pub fn distractor(domain: &str, index: usize) -> NoteInput {
    let mut rng = Rng::new(SEED ^ (index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let system = index % SYSTEM_COUNT;
    let name = format!(
        "{}-{}",
        SYSTEMS[system % SYSTEMS.len()],
        KINDS[system / SYSTEMS.len()]
    );
    let aspect = &ASPECTS[rng.below(ASPECTS.len())];
    let portuguese = rng.chance(0.25);
    let filler = Filler::new(&name, &mut rng);
    let mut used = vec![aspect.templates[0]];
    for _ in 0..1 + rng.below(3) {
        let template = if rng.chance(0.5) {
            aspect.templates[1]
        } else {
            rng.below(TEMPLATES)
        };
        if !used.contains(&template) {
            used.push(template);
        }
    }
    let sentences: Vec<String> = used
        .iter()
        .map(|template| filler.sentence(*template, portuguese, &mut rng))
        .collect();
    let display = capitalized(&name.replace('-', " "));
    let (qualifier_en, qualifier_pt) = QUALIFIERS[rng.below(QUALIFIERS.len())];
    let title = if portuguese {
        format!("{} do {name} ({qualifier_pt})", capitalized(aspect.pt))
    } else {
        format!("{display} {} ({qualifier_en})", aspect.en)
    };
    let mut aliases = Vec::new();
    if rng.chance(0.5) {
        aliases.push(if portuguese {
            format!("{display} {}", aspect.en)
        } else {
            format!("{} do {name}", aspect.pt)
        });
    }
    if rng.chance(0.2) {
        aliases.push(filler.ticket.clone());
    }
    // Earlier notes about the same system, and now and then any earlier note.
    let mut related: Vec<String> = [1, 2]
        .iter()
        .filter_map(|step| index.checked_sub(step * SYSTEM_COUNT))
        .map(key_of)
        .collect();
    if index > 0 && rng.chance(0.05) {
        related.push(key_of(rng.below(index)));
    }
    related.dedup();
    NoteInput {
        domain: domain.to_owned(),
        key: format!("{name}-{}-{index}", aspect.slug),
        title,
        body: sentences.join(" "),
        aliases,
        related,
        tags: vec![
            SYSTEMS[system % SYSTEMS.len()].to_owned(),
            aspect.tag.to_owned(),
        ],
        source: None,
        confidence: 0.6 + rng.below(36) as f64 / 100.0,
        pinned: false,
        lock: Vec::new(),
        paths: Vec::new(),
    }
}

/// The key of the distractor at `index`, without generating its text.
fn key_of(index: usize) -> String {
    let mut rng = Rng::new(SEED ^ (index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let system = index % SYSTEM_COUNT;
    let aspect = &ASPECTS[rng.below(ASPECTS.len())];
    format!(
        "{}-{}-{}-{index}",
        SYSTEMS[system % SYSTEMS.len()],
        KINDS[system / SYSTEMS.len()],
        aspect.slug
    )
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Values one note's sentences share, so they describe the same system.
struct Filler {
    name: String,
    upper: String,
    snake: String,
    ticket: String,
    code: String,
}

/// Number of sentence templates in [`Filler::sentence`].
const TEMPLATES: usize = 20;

impl Filler {
    fn new(name: &str, rng: &mut Rng) -> Self {
        Self {
            name: name.to_owned(),
            upper: name.replace('-', "_").to_uppercase(),
            snake: name.replace('-', "_"),
            ticket: format!("OPS-{}", 1000 + rng.below(9000)),
            code: format!(
                "{}-{}",
                CODE_PREFIXES[rng.below(CODE_PREFIXES.len())],
                1000 + rng.below(9000)
            ),
        }
    }

    fn sentence(&self, template: usize, pt: bool, rng: &mut Rng) -> String {
        let name = &self.name;
        let code = &self.code;
        let ticket = &self.ticket;
        let pick = |rng: &mut Rng, pair: &[(&str, &str)]| -> String {
            let (en, pt_text) = pair[rng.below(pair.len())];
            (if pt { pt_text } else { en }).to_owned()
        };
        let dep = format!(
            "{}-{}",
            SYSTEMS[rng.below(SYSTEMS.len())],
            KINDS[rng.below(KINDS.len())]
        );
        let n = 2 + rng.below(28);
        let m = 2 + rng.below(58);
        let ms = 50 * (1 + rng.below(40));
        let store = STORES[rng.below(STORES.len())];
        let region = REGIONS[rng.below(REGIONS.len())];
        let setting = SETTINGS[rng.below(SETTINGS.len())];
        let hour = rng.below(6);
        match (template, pt) {
            (0, false) => format!(
                "{name} retries calls to {dep} {n} times with exponential backoff starting at {ms} ms; after the last attempt the request fails with {code}."
            ),
            (0, true) => format!(
                "O {name} tenta de novo as chamadas ao {dep} {n} vezes com backoff exponencial a partir de {ms} ms; depois da última tentativa a requisição falha com {code}."
            ),
            (1, false) => format!(
                "Set {}_{} to {n} in staging; production runs with {m} since {ticket}.",
                self.upper,
                setting.to_uppercase()
            ),
            (1, true) => format!(
                "Em homologação, {}_{} fica em {n}; em produção usamos {m} desde o {ticket}.",
                self.upper,
                setting.to_uppercase()
            ),
            (2, false) => format!(
                "Alerts fire when {}.queue.lag_seconds stays above {n} for {m} minutes, and the {} on-call is paged.",
                self.snake,
                pick(rng, &TEAMS)
            ),
            (2, true) => format!(
                "Os alertas disparam quando {}.queue.lag_seconds passa de {n} por {m} minutos, e o plantão do time de {} é acionado.",
                self.snake,
                pick(rng, &TEAMS)
            ),
            (3, false) => format!(
                "{name} keeps {} in {store} for {n} days, then archives them to cold storage in {region}.",
                pick(rng, &DATA)
            ),
            (3, true) => format!(
                "O {name} guarda {} no {store} por {n} dias e depois arquiva em armazenamento frio na região {region}.",
                pick(rng, &DATA)
            ),
            (4, false) => format!(
                "Deploys of {name} need a green canary in {region} and approval from the {} lead; they never run on {}.",
                pick(rng, &TEAMS),
                pick(rng, &DAYS)
            ),
            (4, true) => format!(
                "Deploys do {name} precisam de um canário verde em {region} e da aprovação da liderança de {}; nunca acontecem na {}.",
                pick(rng, &TEAMS),
                pick(rng, &DAYS)
            ),
            (5, _) => {
                let (verb, en, pt_text) = VERBS[rng.below(VERBS.len())];
                if pt {
                    format!(
                        "Rode `opsctl {verb} {name}` para {pt_text}; o comando exige o papel ops-admin."
                    )
                } else {
                    format!(
                        "Run `opsctl {verb} {name}` to {en}; the command needs the ops-admin role."
                    )
                }
            }
            (6, false) => format!(
                "Error {code} means {}; callers should {}.",
                pick(rng, &REASONS),
                pick(rng, &ADVICE)
            ),
            (6, true) => format!(
                "O erro {code} significa que {}; quem chama deve {}.",
                pick(rng, &REASONS),
                pick(rng, &ADVICE)
            ),
            (7, false) => format!(
                "The {setting} setting in services/{name}/config.yaml caps concurrent jobs at {n}; raising it needs a load test first."
            ),
            (7, true) => format!(
                "A configuração {setting} em services/{name}/config.yaml limita os jobs simultâneos a {n}; aumentar exige um teste de carga antes."
            ),
            (8, false) => format!(
                "We chose {store} for {name} because it handles {m} thousand writes per second, after comparing it with {} in {ticket}.",
                STORES[rng.below(STORES.len())]
            ),
            (8, true) => format!(
                "Escolhemos {store} para o {name} porque aguenta {m} mil escritas por segundo, depois de comparar com {} no {ticket}.",
                STORES[rng.below(STORES.len())]
            ),
            (9, false) => format!(
                "{name} reads from the {dep} replica, so its data can lag up to {n} seconds behind."
            ),
            (9, true) => format!(
                "O {name} lê da réplica do {dep}, então os dados podem atrasar até {n} segundos."
            ),
            (10, false) => format!(
                "The nightly compaction job for {name} starts at 0{hour}:30 UTC and must finish before 0{}:00 UTC.",
                hour + 3
            ),
            (10, true) => format!(
                "O job noturno de compactação do {name} começa às 0{hour}:30 UTC e precisa terminar antes das 0{}:00 UTC.",
                hour + 3
            ),
            (11, false) => format!(
                "Owners: the {} team; escalate in #{name}-ops if it is down for more than {n} minutes.",
                pick(rng, &TEAMS)
            ),
            (11, true) => format!(
                "Responsáveis: time de {}; escale em #{name}-ops se ficar fora do ar por mais de {n} minutos.",
                pick(rng, &TEAMS)
            ),
            (12, false) => format!(
                "{name} batches {} in windows of {n} seconds before writing to {store}.",
                pick(rng, &DATA)
            ),
            (12, true) => format!(
                "O {name} agrupa {} em janelas de {n} segundos antes de gravar no {store}.",
                pick(rng, &DATA)
            ),
            (13, false) => format!(
                "The {name} client times out after {ms} ms and opens its circuit breaker after {n} consecutive failures."
            ),
            (13, true) => format!(
                "O cliente do {name} desiste depois de {ms} ms e abre o disjuntor após {n} falhas seguidas."
            ),
            (14, false) => format!(
                "Schema migrations for {name} run as a separate job before the deploy and must stay backward compatible for {n} days."
            ),
            (14, true) => format!(
                "As migrações de esquema do {name} rodam num job separado antes do deploy e precisam ser compatíveis com a versão anterior por {n} dias."
            ),
            (15, false) => format!(
                "{name} invalidates its {store} cache on every write event and caps entries at {m} minutes of age."
            ),
            (15, true) => format!(
                "O {name} invalida o cache no {store} a cada evento de escrita e limita as entradas a {m} minutos."
            ),
            (16, false) => format!(
                "Only the {} team may call the admin endpoints of {name}; requests need the {setting} scope since {ticket}.",
                pick(rng, &TEAMS)
            ),
            (16, true) => format!(
                "Só o time de {} pode chamar os endpoints administrativos do {name}; as requisições precisam do escopo {setting} desde o {ticket}.",
                pick(rng, &TEAMS)
            ),
            (17, false) => format!(
                "{name} may spend at most {m} hundred dollars a month on {store}; the {} lead approves anything above it.",
                pick(rng, &TEAMS)
            ),
            (17, true) => format!(
                "O {name} pode gastar no máximo {m} mil reais por mês com {store}; a liderança de {} aprova o que passar disso.",
                pick(rng, &TEAMS)
            ),
            (18, false) => format!(
                "Load tests for {name} replay {m} thousand requests per minute against staging in {region} before each major release."
            ),
            (18, true) => format!(
                "Os testes de carga do {name} reproduzem {m} mil requisições por minuto contra homologação em {region} antes de cada release grande."
            ),
            (19, false) => format!(
                "The review of {ticket} found that {name} kept retrying while {dep} was down; the fix lowered {setting} to {n}."
            ),
            (19, true) => format!(
                "A revisão do {ticket} mostrou que o {name} continuou tentando enquanto o {dep} estava fora; a correção baixou {setting} para {n}."
            ),
            _ => format!("{name} has no further notes for {ticket}."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rank::fold;

    #[test]
    fn distractors_are_deterministic_and_unique() {
        let first: Vec<NoteInput> = (0..2_000).map(|i| distractor("bench", i)).collect();
        let again: Vec<NoteInput> = (0..2_000).map(|i| distractor("bench", i)).collect();
        assert_eq!(first, again);
        let keys: std::collections::HashSet<&str> = first.iter().map(|n| n.key.as_str()).collect();
        assert_eq!(keys.len(), first.len());
        for note in &first {
            note.validate().expect("valid note");
            for reference in &note.related {
                assert!(keys.contains(reference.as_str()), "{reference} resolves");
            }
        }
        let portuguese = first.iter().filter(|n| n.title.contains(" do ")).count();
        assert!((300..700).contains(&portuguese), "{portuguese} of 2000");
    }

    #[test]
    fn no_distractor_label_equals_a_graded_query() {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("evals/retrieval/dataset.json");
        let dataset = super::super::Dataset::load(&root).expect("dataset loads");
        let queries: std::collections::HashSet<String> = dataset
            .queries
            .iter()
            .map(|q| {
                fold(&q.query)
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        for index in 0..5_000 {
            let note = distractor("bench", index);
            for label in std::iter::once(&note.key)
                .chain(std::iter::once(&note.title))
                .chain(&note.aliases)
            {
                let label = fold(label).split_whitespace().collect::<Vec<_>>().join(" ");
                assert!(!queries.contains(&label), "{label} equals a query");
            }
        }
    }
}
