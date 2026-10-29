/** Bounded JSON attributes accepted at the source boundary. */
export type AdfJson = null | boolean | number | string | AdfJson[] | {
    [key: string]: AdfJson;
};
/** ADF source node; unfamiliar node types are counted and excluded, including their descendants. */
export interface AdfSourceNode {
    type: string;
    version?: number;
    text?: string;
    attrs?: Record<string, AdfJson>;
    marks?: {
        type: string;
        attrs?: Record<string, AdfJson>;
    }[];
    content?: AdfSourceNode[];
}
/** Caller-observed issue revision, scoped to one Jira origin and key. */
export interface AdfSource {
    site: string;
    issue: string;
    revision: string;
    document: AdfSourceNode;
}
/** Strict v1 request. Pointers are relative to the description root, never attachment paths. */
export interface AdfCaptureInput {
    version: 1;
    source: AdfSource;
    select: string[];
    approval?: {
        revision: string;
        digest: string;
    };
    budget?: number;
}
/** One retained node at its original coordinate; context rows carry no unselected content. */
export interface AdfEvidenceNode {
    pointer: string;
    type: string;
    context: boolean;
    text?: string;
    attrs?: Record<string, AdfJson>;
    marks?: {
        type: string;
    }[];
}
/** Complete immutable selection; digest binds source identity, selection, rows and counts. */
export interface AdfEvidencePacket {
    version: 1;
    source: {
        site: string;
        issue: string;
        revision: string;
        digest: string;
    };
    select: string[];
    nodes: AdfEvidenceNode[];
    counts: {
        source: number;
        retained: number;
        context: number;
        unselected: number;
        unsupported: number;
        attachments: number;
        omittedMarks: number;
    };
    digest: string;
}
/** Stable refusals shared by direct SDK consumers and host command output. */
export interface AdfEvidenceRefusal {
    kind: "refused";
    code: "invalid_input" | "selection_missing" | "source_changed" | "budget_exceeded" | "invalid_packet" | "input_read";
    remediation: string;
    exit_code: 2;
}
/** Preview and approved capture share the exact same compiler and output schema. */
export type AdfCaptureResult = {
    kind: "preview" | "captured";
    packet: AdfEvidencePacket;
} | AdfEvidenceRefusal;
/** Reconstructed selective ADF plus addresses mapping dense replay coordinates to original source coordinates. */
export type AdfReplayResult = {
    kind: "replayed";
    document: AdfSourceNode;
    coordinates: {
        pointer: string;
        sourcePointer: string;
    }[];
} | AdfEvidenceRefusal;
/** Redact invalid input while giving a concrete retry path. */
export declare function adfEvidenceRefusal(code: AdfEvidenceRefusal["code"]): AdfEvidenceRefusal;
/** Compile selected rows and ancestor boundaries, binding approval to the entire observed source. */
export declare function captureAdfEvidence(value: unknown): AdfCaptureResult;
/** Replay a complete packet into selective ADF with stable original source addresses. */
export declare function replayAdfEvidence(value: unknown): AdfReplayResult;
//# sourceMappingURL=adf-evidence.d.ts.map