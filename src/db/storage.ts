import * as dynamodb from './dynamodb.js';
import * as supabase from './supabase.js';

export type StorageProvider = 'supabase' | 'dynamodb';

function getProvider(): StorageProvider {
  // Default to Supabase for the "supabase instead of aws" workflow.
  const raw = (process.env.STORAGE_PROVIDER ?? 'supabase').toLowerCase().trim();
  if (raw === 'dynamodb' || raw === 'supabase') return raw;
  return 'supabase';
}

function backend() {
  const provider = getProvider();
  return provider === 'dynamodb' ? dynamodb : supabase;
}

export async function getItem<T>(pk: string, sk: string): Promise<T | null> {
  return backend().getItem<T>(pk, sk);
}

export async function putItem(
  pk: string,
  sk: string,
  data: Record<string, unknown>,
  ttlSeconds?: number,
): Promise<void> {
  return backend().putItem(pk, sk, data, ttlSeconds);
}

export async function deleteItem(pk: string, sk: string): Promise<void> {
  return backend().deleteItem(pk, sk);
}

export async function updateItem(
  pk: string,
  sk: string,
  updates: Record<string, unknown>,
): Promise<void> {
  return backend().updateItem(pk, sk, updates);
}

export async function queryByPk<T>(pk: string): Promise<T[]> {
  return backend().queryByPk<T>(pk);
}

