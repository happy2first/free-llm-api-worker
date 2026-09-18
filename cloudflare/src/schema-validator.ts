import { Validator } from '@cfworker/json-schema';

// Runtime schemas cannot be precompiled at build time. Supply just the small
// Ajv interface used by upstream tool-validate, with no eval/new Function.
export default class WorkerSchemaValidator {
  compile(schema: Record<string, unknown>) {
    const validator = new Validator(withoutFormats(schema), '2020-12', false);
    const check = (data: unknown): boolean => {
      try {
        const result = validator.validate(data);
        check.errors = result.errors.map(error => ({ instancePath: error.instanceLocation, message: error.error }));
        return result.valid;
      } catch {
        // Match upstream's fail-open policy for schemas it cannot interpret.
        check.errors = [];
        return true;
      }
    };
    check.errors = [] as Array<{ instancePath: string; message: string }>;
    return check;
  }
}

// Upstream uses validateFormats:false. Traverse SCHEMA positions only: a
// property named "format", or a const/enum object, must remain untouched.
function withoutFormats(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(withoutFormats);
  const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
  const children = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'prefixItems']);
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'format').map(([key, value]) => [key,
    maps.has(key) && value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, withoutFormats(child)]))
      : children.has(key) ? withoutFormats(value) : value,
  ]));
}
