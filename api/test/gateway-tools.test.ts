import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTES } from '../src/routes.ts';

const doc = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const tools: any[] = JSON.parse(readFileSync(new URL('../gateway-tools.json', import.meta.url), 'utf8'));

function operation(id: string): any {
  for (const item of Object.values<any>(doc.paths)) {
    for (const op of Object.values<any>(item)) if (op.operationId === id) return op;
  }
  throw new Error(`no operation ${id}`);
}

// The properties the document gives an operation: query parameters, or the body properties of a write.
function documented(op: any): { properties: Record<string, any>; required: string[] } {
  if (op.requestBody) {
    const schema = op.requestBody.content['application/json'].schema;
    return { properties: schema.properties, required: schema.required };
  }
  const parameters: any[] = op.parameters ?? [];
  return {
    properties: Object.fromEntries(parameters.map((p) => [p.name, { ...p.schema, description: p.description }])),
    required: parameters.filter((p) => p.required).map((p) => p.name),
  };
}

test('the tool definitions are the five operations in the order of ROUTES', () => {
  assert.deepEqual(tools.map((t) => t.name), ROUTES.map((r) => r.operationId));
  for (const tool of tools) assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema']);
});

test('each description is the summary followed by the description of the operation', () => {
  for (const tool of tools) {
    const op = operation(tool.name);
    assert.equal(tool.description, `${op.summary} ${op.description}`, tool.name);
  }
});

test('each input schema matches the document: properties, required, enum and bounds', () => {
  for (const tool of tools) {
    const { properties, required } = documented(operation(tool.name));
    const schema = tool.inputSchema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties), Object.keys(properties), tool.name);
    assert.deepEqual([...schema.required].sort(), [...required].sort(), tool.name);
    for (const [name, want] of Object.entries<any>(properties)) {
      const have = schema.properties[name];
      assert.equal(have.type, want.type, `${tool.name} ${name} type`);
      assert.equal(have.description, want.description, `${tool.name} ${name} description`);
      assert.deepEqual(have.enum, want.enum, `${tool.name} ${name} enum`);
      assert.equal(have.minimum, want.minimum, `${tool.name} ${name} minimum`);
      assert.equal(have.maximum, want.maximum, `${tool.name} ${name} maximum`);
      assert.deepEqual(
        Object.keys(have).filter((k) => !['type', 'description', 'enum', 'minimum', 'maximum'].includes(k)),
        [],
        `${tool.name} ${name} has no other keys`,
      );
    }
  }
});

test('every tool and every property has a description', () => {
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, tool.name);
    for (const [name, property] of Object.entries<any>(tool.inputSchema.properties)) {
      assert.ok(typeof property.description === 'string' && property.description.length > 0, `${tool.name} ${name}`);
    }
  }
});
