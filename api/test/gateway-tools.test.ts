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
    assert.equal(tool.description, [op.summary, op.description].filter(Boolean).join(' '), tool.name);
  }
});

test('each input schema matches the document: properties, required and types', () => {
  for (const tool of tools) {
    const { properties, required } = documented(operation(tool.name));
    const schema = tool.inputSchema;
    assert.equal(schema.type, 'object');
    assert.deepEqual(Object.keys(schema.properties), Object.keys(properties), tool.name);
    assert.deepEqual([...schema.required].sort(), [...required].sort(), tool.name);
    for (const [name, want] of Object.entries<any>(properties)) {
      assert.equal(schema.properties[name].type, want.type, `${tool.name} ${name} type`);
    }
  }
});

// The gateway accepts only these keys in a schema definition of a tool.
const ALLOWED_KEYS = ['type', 'description', 'properties', 'required'];

function walk(node: any, where: string) {
  assert.deepEqual(Object.keys(node).filter((k) => !ALLOWED_KEYS.includes(k)), [], `${where} uses only keys the gateway accepts`);
  for (const [name, child] of Object.entries<any>(node.properties ?? {})) walk(child, `${where}.${name}`);
}

test('every schema object uses only the keys type, description, properties and required', () => {
  for (const tool of tools) walk(tool.inputSchema, tool.name);
});

test('the description of a property states each allowed value and each bound the document gives', () => {
  for (const tool of tools) {
    const { properties } = documented(operation(tool.name));
    for (const [name, want] of Object.entries<any>(properties)) {
      const text: string = tool.inputSchema.properties[name].description;
      for (const value of want.enum ?? []) assert.ok(text.includes(String(value)), `${tool.name} ${name} mentions ${value}`);
      for (const bound of [want.minimum, want.maximum]) {
        if (bound !== undefined) assert.ok(text.includes(String(bound)), `${tool.name} ${name} mentions ${bound}`);
      }
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
