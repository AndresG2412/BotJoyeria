import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
//  Catálogo sobre Supabase (Postgres)
//  Tablas: categorias, productos

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
//  CATEGORÍAS
// ─────────────────────────────────────────
export type Categoria = {
    id: string;
    nombre: string;
};

export async function getAllCategorias(): Promise<Categoria[]> {
    if (!supabase) return [];
    try {
        const { data, error } = await supabase
            .from('categorias')
            .select('id, nombre')
            .order('nombre', { ascending: true });

        if (error) throw error;

        if (!data || data.length === 0) {
            logger.info('Tabla "categorias" vacía. Sembrando categorías iniciales...');
            const initialCats = [
                { id: 'generales', nombre: 'General' },
                { id: 'anillos', nombre: 'Anillos' },
                { id: 'cadenas_collares', nombre: 'Cadenas y Collares' },
                { id: 'pulseras', nombre: 'Pulseras' },
                { id: 'aretes', nombre: 'Aretes y Topos' },
                { id: 'dijes', nombre: 'Dijes y Candados' }
            ];
            const { error: seedError } = await supabase.from('categorias').upsert(initialCats, { onConflict: 'id' });
            if (seedError) throw seedError;
            return initialCats;
        }

        return data.map(row => ({ id: row.id, nombre: row.nombre || row.id }));
    } catch (e) {
        logger.error(`Error getting all categories: ${e}`);
        return [];
    }
}

export async function createCategoria(nombre: string): Promise<Categoria | null> {
    if (!supabase) return null;
    try {
        const id = nombre.toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)+/g, '');
        const finalId = id || `cat_${Date.now()}`;
        const newCat = { id: finalId, nombre };

        const { error } = await supabase
            .from('categorias')
            .upsert(newCat, { onConflict: 'id' });

        if (error) throw error;
        return newCat;
    } catch (e) {
        logger.error(`Error creating category: ${e}`);
        return null;
    }
}

export async function updateCategoria(id: string, nombre: string): Promise<Categoria | null> {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('categorias')
            .update({ nombre })
            .eq('id', id)
            .select();

        if (error) throw error;
        if (!data || data.length === 0) return null;
        return { id: data[0].id, nombre: data[0].nombre };
    } catch (e) {
        logger.error(`Error updating category: ${e}`);
        return null;
    }
}

export async function deleteCategoria(id: string): Promise<boolean> {
    if (!supabase) return false;
    try {
        // Los productos de esta categoría pasan a 'generales' para no dejarlos huérfanos
        if (id !== 'generales') {
            const { error: moveError } = await supabase
                .from('productos')
                .update({ categoria_id: 'generales' })
                .eq('categoria_id', id);
            if (moveError) throw moveError;
        }

        const { data, error } = await supabase
            .from('categorias')
            .delete()
            .eq('id', id)
            .select('id');

        if (error) throw error;
        return !!(data && data.length > 0);
    } catch (e) {
        logger.error(`Error deleting category: ${e}`);
        return false;
    }
}

// ─────────────────────────────────────────
//  PRODUCTOS (propiedades)
// ─────────────────────────────────────────
export type Product = {
    id: string;
    storeId: string;
    nombre: string;
    name: string;          // nombre real
    description: string;   // características formateadas
    productType: string;   // siempre 'joya'
    price: number;         // precio
    imageUrl: string;      // primera imagen
    checkoutUrl: string;   // vacío por ahora
    caracteristicas: string[];
    peso: number;
    stock: number;
    imagenes: string[];
    categoriaId: string;
};

export async function searchProducts(query: string, storeId: string): Promise<Product[]> {
    const products = await getAllProducts(storeId);
    const lowerQuery = query.toLowerCase();
    return products.filter(p =>
        p.name.toLowerCase().includes(lowerQuery) ||
        p.description.toLowerCase().includes(lowerQuery) ||
        p.caracteristicas.some(c => c.toLowerCase().includes(lowerQuery))
    ).slice(0, 5);
}

/** Convierte una fila de la tabla `productos` al tipo Product que usa el bot/panel. */
function mapRowToProduct(row: any): Product {
    const imagenes: string[] = Array.isArray(row.imagenes) ? row.imagenes : [];
    const caracteristicas: string[] = Array.isArray(row.caracteristicas) ? row.caracteristicas : [];
    const nombre = row.nombre || '';

    const description = [
        row.peso ? `Peso: ${row.peso}g` : '',
        row.stock ? `Stock: ${row.stock}` : '',
        caracteristicas.length > 0 ? `Detalles: ${caracteristicas.join(', ')}` : '',
    ].filter(Boolean).join(' | ');

    return {
        id: row.id,
        storeId: row.store_id || 'default',
        nombre,
        name: nombre,
        description,
        productType: 'joya',
        price: row.precio || 0,
        imageUrl: imagenes[0] || '',
        checkoutUrl: row.checkout_url || '',
        caracteristicas,
        peso: row.peso || 0,
        stock: row.stock || 0,
        imagenes,
        categoriaId: row.categoria_id || 'generales',
    };
}

export async function getProductById(id: string, storeId: string): Promise<Product | null> {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('productos')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) throw error;
        if (!data) return null;
        return mapRowToProduct(data);
    } catch (e) {
        logger.error(`Error getting product by id: ${e}`);
        return null;
    }
}

export async function getProductRawImages(id: string, storeId: string): Promise<string[]> {
    if (!supabase) return [];
    try {
        const { data, error } = await supabase
            .from('productos')
            .select('imagenes')
            .eq('id', id)
            .maybeSingle();

        if (error) throw error;
        if (data && Array.isArray(data.imagenes) && data.imagenes.length > 0) return data.imagenes;
        return [];
    } catch (e) {
        logger.error(`Error getting product images: ${e}`);
        return [];
    }
}

export async function getAllProducts(storeId?: string, categoriaId?: string): Promise<Product[]> {
    if (!supabase) return [];
    try {
        let query = supabase.from('productos').select('*');
        if (categoriaId) {
            query = query.eq('categoria_id', categoriaId);
        }
        const { data, error } = await query;
        if (error) throw error;
        return (data || []).map(mapRowToProduct);
    } catch (e) {
        logger.error(`Error getting all products: ${e}`);
        return [];
    }
}

export type ProductFilter = {
    categoriaId: string;
    ciudad?: string;
    tipo_propiedad?: string;
    presupuestoMax?: number;
};

export async function getProductsFiltered(filter: ProductFilter): Promise<Product[]> {
    if (!supabase) return [];
    try {
        const { data, error } = await supabase
            .from('productos')
            .select('*')
            .eq('categoria_id', filter.categoriaId);

        if (error) throw error;
        let rows = data || [];

        if (filter.ciudad) {
            const ciudadNorm = normalizeText(filter.ciudad);
            rows = rows.filter(r => normalizeText(r.ciudad) === ciudadNorm);
        }
        if (filter.tipo_propiedad) {
            const tipoNorm = normalizeText(filter.tipo_propiedad);
            rows = rows.filter(r => normalizeText(r.tipo_propiedad).includes(tipoNorm) || tipoNorm.includes(normalizeText(r.tipo_propiedad)));
        }

        let results = rows.map(mapRowToProduct);

        // El presupuesto solo se aplica si el cliente dio una cifra concreta (> 0).
        // Si no dio presupuesto, se muestran TODAS las opciones disponibles.
        if (filter.presupuestoMax && filter.presupuestoMax > 0) {
            results = results.filter(p => p.price > 0 && p.price <= filter.presupuestoMax!);
        }

        return results;
    } catch (e) {
        logger.error(`Error filtering products: ${e}`);
        return [];
    }
}

/**
 * Busca alternativas dentro de una categoría cuando el filtro exacto no devuelve nada.
 * Relaja los criterios en este orden para nunca dejar al cliente sin opciones:
 *   1) misma ciudad, cualquier tipo y precio
 *   2) mismo tipo, cualquier ciudad y precio
 *   3) cualquier propiedad de la categoría
 * Devuelve además las ciudades y tipos realmente disponibles para que el bot
 * pueda ofrecer cross-sell ("no hay en Timaná, pero tengo en Pitalito").
 */
export async function getAlternativeProducts(filter: ProductFilter): Promise<{
    porCiudad: Product[];
    porTipo: Product[];
    enCategoria: Product[];
    ciudadesDisponibles: string[];
    tiposDisponibles: string[];
}> {
    const empty = { porCiudad: [], porTipo: [], enCategoria: [], ciudadesDisponibles: [], tiposDisponibles: [] };
    if (!supabase) return empty;
    try {
        const { data, error } = await supabase
            .from('productos')
            .select('*')
            .eq('categoria_id', filter.categoriaId);

        if (error) throw error;
        const rows = data || [];
        if (rows.length === 0) return empty;

        const ciudadNorm = filter.ciudad ? normalizeText(filter.ciudad) : '';
        const tipoNorm   = filter.tipo_propiedad ? normalizeText(filter.tipo_propiedad) : '';

        const porCiudadRows = ciudadNorm
            ? rows.filter(r => normalizeText(r.ciudad) === ciudadNorm)
            : [];
        const porTipoRows = tipoNorm
            ? rows.filter(r => normalizeText(r.tipo_propiedad).includes(tipoNorm) || tipoNorm.includes(normalizeText(r.tipo_propiedad)))
            : [];

        const ciudadesDisponibles = [...new Set(rows.map(r => r.ciudad).filter(Boolean) as string[])];
        const tiposDisponibles    = [...new Set(rows.map(r => r.tipo_propiedad).filter(Boolean) as string[])];

        return {
            porCiudad: porCiudadRows.map(mapRowToProduct),
            porTipo: porTipoRows.map(mapRowToProduct),
            enCategoria: rows.map(mapRowToProduct),
            ciudadesDisponibles,
            tiposDisponibles,
        };
    } catch (e) {
        logger.error(`Error getting alternative products: ${e}`);
        return empty;
    }
}

// Las funciones de escritura se mantienen pero no se usan desde el bot
export async function createProduct(product: Partial<Product>, storeId: string): Promise<Product | null> {
    if (!supabase) return null;
    try {
        const newRow = {
            store_id: storeId || 'default',
            nombre: product.nombre || product.name || '',
            caracteristicas: product.caracteristicas || [],
            peso: product.peso || 0,
            stock: product.stock || 0,
            precio: product.price || 0,
            imagenes: product.imagenes || [],
            categoria_id: product.categoriaId || 'generales',
            checkout_url: product.checkoutUrl || '',
        };

        const { data, error } = await supabase
            .from('productos')
            .insert(newRow)
            .select()
            .maybeSingle();

        if (error) throw error;
        if (!data) return null;
        return mapRowToProduct(data);
    } catch (e: any) {
        logger.error(`Error creating product: ${e?.message || JSON.stringify(e)}`);
        return null;
    }
}

export async function updateProduct(id: string, updates: Partial<Product>, storeId: string): Promise<Product | null> {
    if (!supabase) return null;
    try {
        const dbUpdates: any = {};
        if (updates.nombre !== undefined) dbUpdates.nombre = updates.nombre;
        if (updates.name !== undefined) dbUpdates.nombre = updates.nombre || updates.name;
        if (updates.caracteristicas !== undefined) dbUpdates.caracteristicas = updates.caracteristicas;
        if (updates.peso !== undefined) dbUpdates.peso = updates.peso;
        if (updates.stock !== undefined) dbUpdates.stock = updates.stock;
        if (updates.price !== undefined) dbUpdates.precio = updates.price;
        if (updates.imagenes !== undefined) dbUpdates.imagenes = updates.imagenes;
        if (updates.checkoutUrl !== undefined) dbUpdates.checkout_url = updates.checkoutUrl;
        if (updates.categoriaId !== undefined) dbUpdates.categoria_id = updates.categoriaId;
        dbUpdates.updated_at = new Date().toISOString();

        logger.info(`Supabase updating product ${id} with: ${JSON.stringify(dbUpdates)}`);

        const { data, error } = await supabase
            .from('productos')
            .update(dbUpdates)
            .eq('id', id)
            .select();

        if (error) throw error;
        if (!data || data.length === 0) return null;
        return mapRowToProduct(data[0]);
    } catch (e) {
        logger.error(`Error updating product: ${e}`);
        return null;
    }
}

export async function deleteProduct(id: string, storeId: string): Promise<boolean> {
    if (!supabase) return false;
    try {
        const { data, error } = await supabase
            .from('productos')
            .delete()
            .eq('id', id)
            .select('id');

        if (error) throw error;
        return !!(data && data.length > 0);
    } catch (e) {
        logger.error(`Error deleting product: ${e}`);
        return false;
    }
}
