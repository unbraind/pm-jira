export declare function readStringOption(options: Record<string, unknown>, kebab: string): string | undefined;
export declare function readNumberOption(options: Record<string, unknown>, kebab: string): number | undefined;
export declare function readBooleanOption(options: Record<string, unknown>, kebab: string): boolean;
export declare function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined;
export declare function optionInt(options: Record<string, unknown>, defaultValue: number, ...keys: string[]): number;
export declare function optionEnabled(options: Record<string, unknown>, ...keys: string[]): boolean;
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map