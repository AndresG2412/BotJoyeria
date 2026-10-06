import { config } from '../config/env';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
//  Catálogo leído de la tienda (https://www.mr18kts.online)
//
//  El inventario se administra en el panel de la tienda (/admin). El bot solo LEE
//  su API pública: ve únicamente lo publicado, no necesita credenciales de la base
//  y no puede modificar nada. Las respuestas se guardan en memoria unos minutos.
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza texto para comparaciones tolerantes a acentos, mayúsculas y espacios. */
export function normalizeText(value: string): string {
    return (value || '')
        .toString()
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

// ─────────────────────────────────────────
//  Tipos
// ─────────────────────────────────────────
export type Categoria = {
    id: string;       // slug de la categoría en la tienda
    nombre: string;
};

export type Product = {
    id: string;
    storeId: string;
    nombre: string;
    name: string;
    description: string;
    productType: string;   // siempre 'joya'
    price: number;         // 0 = precio a consultar
    imageUrl: string;
    checkoutUrl: string;
    caracteristicas: string[];
    peso: number;
    stock: number;
    imagenes: string[];
    categoriaId: string;
    material?: string;
    piedra?: string;
    colorMetal?: string;
    colorPiedra?: string;
    estilo?: string;
    slug?: string;
    url?: string;          // ficha de la pieza en la tienda
    categorias?: string[]; // nombres de todas sus categorías
    porEncargo?: boolean;
};

// Etiquetas de los valores que guarda la tienda (src/collections/opciones-joya.ts del sitio).
const MATERIALES: Record<string, string> = {
    'oro-amarillo-18k': 'Oro amarillo 18K',
    'oro-blanco-18k': 'Oro blanco 18K',
    'oro-rosa-18k': 'Oro rosa 18K',
    'plata-925': 'Plata 925',
};
const TONOS: Record<string, string> = {
    amarillo: 'Oro amarillo',
    blanco: 'Oro blanco',
    rosa: 'Oro rosa',
};
const GEMAS: Record<string, { nombre: string; color: string }> = {
    esmeralda: { nombre: 'Esmeralda colombiana', color: 'verde' },
    diamante: { nombre: 'Diamante', color: 'blanco transparente' },
    zafiro: { nombre: 'Zafiro', color: 'azul' },
    rubi: { nombre: 'Rubí', color: 'rojo' },
    circon: { nombre: 'Circón', color: 'blanco transparente' },
};

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;

function siteUrl(): string {
    return config.SITE_URL.replace(/\/+$/, '');
}

function absoluteUrl(path: string): string {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return `${siteUrl()}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Foto en tamaño «tarjeta» (WebP de 750 px): liviana para WhatsApp y fiel a la pieza. */
function photoUrl(media: any): string {
    if (!media || typeof media !== 'object' || media.interna) return '';
    return absoluteUrl(media.sizes?.tarjeta?.url || media.sizes?.grande?.url || media.url || '');
}

/** Convierte una pieza de la API de la tienda al tipo Product que usan el bot y el panel. */
export function mapSitePiece(doc: any, storeId = 'default'): Product {
    const nombre = String(doc?.titulo || '').trim();
    const material = MATERIALES[doc?.material] || '';
    const gema = doc?.gema && doc.gema !== 'ninguna' ? GEMAS[doc.gema] : undefined;
    const tonos: string[] = (Array.isArray(doc?.tonos) ? doc.tonos : []).map((t: string) => TONOS[t] || t);
    const categorias = (Array.isArray(doc?.categorias) ? doc.categorias : [])
        .filter((c: any) => c && typeof c === 'object');
    const imagenes = (Array.isArray(doc?.galeria) ? doc.galeria : [])
        .map((item: any) => photoUrl(item?.imagen))
        .filter(Boolean);
    const price = doc?.priceInCOPEnabled && Number(doc?.priceInCOP) > 0 ? Number(doc.priceInCOP) : 0;
    const peso = Number(doc?.pesoGramos) || 0;
    const stock = Number(doc?.inventory) || 0;
    const resumen = String(doc?.resumen || '').replace(/\s+/g, ' ').trim();

    const caracteristicas = [
        material,
        gema?.nombre || '',
        ...tonos.filter(t => !material.toLowerCase().startsWith(t.toLowerCase())),
        resumen,
    ].filter(Boolean);

    const description = [
        resumen,
        material ? `Material: ${material}` : '',
        gema ? `Piedra: ${gema.nombre}` : '',
        tonos.length > 0 ? `Tonos: ${tonos.join(', ')}` : '',
        peso ? `Peso: ${peso} g` : '',
    ].filter(Boolean).join(' | ');

    const slug = String(doc?.slug || '');
    return {
        id: String(doc?.id ?? ''),
        storeId,
        nombre,
        name: nombre,
        description,
        productType: 'joya',
        price,
        imageUrl: imagenes[0] || '',
        checkoutUrl: '',
        caracteristicas,
        peso,
        stock,
        imagenes,
        categoriaId: categorias[0]?.slug || 'generales',
        material,
        piedra: gema?.nombre || '',
        colorMetal: tonos.join(', '),
        colorPiedra: gema?.color || '',
        estilo: '',
        slug,
        url: slug ? `${siteUrl()}/pieza/${slug}` : siteUrl(),
        categorias: categorias.map((c: any) => String(c.titulo || c.slug || '')).filter(Boolean),
        porEncargo: !!doc?.porEncargo,
    };
}

// ─────────────────────────────────────────
//  Lectura con caché
// ─────────────────────────────────────────
type CatalogSnapshot = { at: number; products: Product[]; categorias: Categoria[] };

let snapshot: CatalogSnapshot | null = null;
let inflight: Promise<CatalogSnapshot | null> | null = null;

async function getJson(path: string): Promise<any> {
    const response = await fetch(`${siteUrl()}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} en ${path}`);
    return response.json();
}

async function fetchAllPieces(): Promise<any[]> {
    const docs: any[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await getJson(`/api/products?depth=1&limit=${PAGE_SIZE}&page=${page}&sort=titulo`);
        docs.push(...(Array.isArray(data?.docs) ? data.docs : []));
        if (!data?.hasNextPage) break;
    }
    return docs;
}

async function fetchCategorias(): Promise<Categoria[]> {
    const data = await getJson(`/api/categorias?depth=0&limit=${PAGE_SIZE}&sort=titulo`);
    return (Array.isArray(data?.docs) ? data.docs : [])
        .filter((c: any) => c?.slug)
        .map((c: any) => ({ id: String(c.slug), nombre: String(c.titulo || c.slug) }));
}

async function refreshSnapshot(): Promise<CatalogSnapshot | null> {
    try {
        const [docs, categorias] = await Promise.all([fetchAllPieces(), fetchCategorias()]);
        const products = docs
            // La API pública ya oculta borradores; se filtra igual por si cambia el acceso.
            .filter(doc => !doc?._status || doc._status === 'published')
            .map(doc => mapSitePiece(doc))
            .filter(p => p.id && p.name);
        snapshot = { at: Date.now(), products, categorias };
        return snapshot;
    } catch (e: any) {
        logger.error(`No se pudo leer el catálogo de la tienda: ${e?.message || e}`);
        // Si la tienda no responde, se sigue usando la última copia buena.
        return snapshot;
    }
}

async function getSnapshot(): Promise<CatalogSnapshot | null> {
    if (snapshot && Date.now() - snapshot.at < config.CATALOG_CACHE_MS) return snapshot;
    if (!inflight) {
        inflight = refreshSnapshot().finally(() => { inflight = null; });
    }
    return inflight;
}

/** Olvida la copia en memoria (pruebas y botón «actualizar» del panel). */
export function clearCatalogCache(): void {
    snapshot = null;
}

// ─────────────────────────────────────────
//  API usada por el bot y el panel
//  (storeId se mantiene por compatibilidad: el catálogo es el de la única tienda)
// ─────────────────────────────────────────
export async function getAllCategorias(): Promise<Categoria[]> {
    return (await getSnapshot())?.categorias || [];
}

export async function getAllProducts(_storeId?: string, categoriaId?: string): Promise<Product[]> {
    const products = (await getSnapshot())?.products || [];
    if (!categoriaId) return products;
    return products.filter(p => matchesCategory(p, categoriaId));
}

/** Busca una pieza por id, slug o nombre exacto (lo que llegue del cliente o de la web). */
export function findProductByReference(products: Product[], reference: string): Product | null {
    const ref = (reference || '').trim();
    if (!ref) return null;
    const normalized = normalizeText(ref).replace(/[.!?¿¡]+$/g, '').trim();
    return products.find(p => p.id === ref)
        || products.find(p => p.slug && p.slug === ref.toLowerCase())
        || products.find(p => normalizeText(p.name) === normalized)
        || null;
}

export async function getProductById(id: string, _storeId?: string): Promise<Product | null> {
    return findProductByReference(await getAllProducts(), id);
}

export async function getProductRawImages(id: string, storeId?: string): Promise<string[]> {
    return (await getProductById(id, storeId))?.imagenes || [];
}

// ─────────────────────────────────────────
//  Búsqueda y filtros
// ─────────────────────────────────────────
const STOPWORDS = new Set([
    'de', 'del', 'la', 'las', 'el', 'los', 'un', 'una', 'unos', 'unas', 'con', 'sin', 'en', 'para',
    'por', 'y', 'o', 'que', 'me', 'mi', 'quiero', 'busco', 'tienen', 'tiene', 'hay', 'algo',
]);

/** Quita plurales simples para que "anillos" encuentre "anillo" y "aretes" encuentre "arete". */
function stem(word: string): string {
    if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
    return word;
}

function tokens(value: string): string[] {
    return normalizeText(value)
        .split(/[^a-z0-9]+/)
        .filter(word => word.length > 1 && !STOPWORDS.has(word))
        .map(stem);
}

function productSearchText(product: Product): string {
    return normalizeText([
        product.name,
        product.description,
        ...product.caracteristicas,
        ...(product.categorias || []),
        product.categoriaId,
        product.material,
        product.piedra,
        product.colorMetal,
        product.colorPiedra,
        product.estilo,
    ].filter(Boolean).join(' '));
}

function productTokens(product: Product): Set<string> {
    return new Set(tokens(productSearchText(product)));
}

/** Todas las palabras útiles de la búsqueda deben aparecer en la pieza (en cualquier orden). */
export function matchesQuery(product: Product, query: string): boolean {
    const wanted = tokens(query);
    if (wanted.length === 0) return false;
    const have = productTokens(product);
    const text = productSearchText(product);
    return wanted.every(word => have.has(word) || text.includes(word));
}

export async function searchProducts(query: string, storeId?: string): Promise<Product[]> {
    const products = await getAllProducts(storeId);
    const exact = findProductByReference(products, query);
    if (exact) return [exact];
    return products.filter(p => matchesQuery(p, query)).slice(0, 5);
}

export type ProductFilter = {
    storeId: string;
    categoriaId?: string;
    presupuestoMax?: number;
    material?: string;
    piedra?: string;
    colorMetal?: string;
    colorPiedra?: string;
    estilo?: string;
    disponibilidad?: 'disponible' | 'bajo_pedido' | 'cualquiera';
};

function matchesCategory(product: Product, categoria: string): boolean {
    const wanted = tokens(categoria);
    if (wanted.length === 0) return true;
    const names = [product.categoriaId, ...(product.categorias || []), product.name];
    const have = new Set(names.flatMap(tokens));
    return wanted.some(word => have.has(word));
}

function includesFilter(product: Product, value?: string): boolean {
    return !value || matchesQuery(product, value);
}

/** Filtrado progresivo para el asesor: categoría, material, piedra, colores, presupuesto y stock. */
export async function filterProducts(filters: ProductFilter): Promise<Product[]> {
    const products = await getAllProducts(filters.storeId);
    return products.filter(product => matchesProductFilters(product, filters));
}

export function matchesProductFilters(product: Product, filters: ProductFilter): boolean {
    if (filters.categoriaId && !matchesCategory(product, filters.categoriaId)) return false;
    if (!includesFilter(product, filters.material)) return false;
    if (!includesFilter(product, filters.piedra)) return false;
    if (!includesFilter(product, filters.colorMetal)) return false;
    if (!includesFilter(product, filters.colorPiedra)) return false;
    if (!includesFilter(product, filters.estilo)) return false;
    if (filters.presupuestoMax && filters.presupuestoMax > 0 && (product.price <= 0 || product.price > filters.presupuestoMax)) return false;
    if (filters.disponibilidad === 'disponible' && product.stock <= 0) return false;
    if (filters.disponibilidad === 'bajo_pedido' && product.stock > 0) return false;
    return true;
}
