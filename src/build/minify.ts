import * as fs from 'fs-extra';
import * as path from 'path';
import { minify as terserMinify, MinifyOptions, MinifyOutput } from 'terser';
import { minify as htmlMinifierMinify, Options as HtmlMinifierOptions } from 'html-minifier-terser';
import CleanCSS from 'clean-css';

// --- 核心配置 ---
const TARGET_DIR = 'dist';
const INDEX_HTML = path.join(TARGET_DIR, 'index.html');
const FAVICON_ICO = path.join(TARGET_DIR, 'favicon.ico');

const cleanCss = new CleanCSS({});

// 正则表达式用于匹配 index.html 中对外部 JS、CSS 和 Favicon 的引用
const JS_REGEX = /<script\s+(?:type="text\/javascript"\s+)?src="([^"]+\.js)"\s*><\/script>/gi;
const CSS_LINK_REGEX = /<link\s+rel="stylesheet"\s+href="([^"]+\.css)"(?:\s+\/)?\s*>/gi;
const FAVICON_REGEX = /(<link\s+[^>]*?rel="(?:icon|shortcut\s+icon)"[^>]*?href="([^"]+\.ico)"[^>]*?>)/gi;

// 正则表达式用于匹配 CSS 文件中的 url() 引用 (仅针对字体)
const CSS_URL_REGEX = /url\(['"]?([^'"\)]+\.(?:ttf|woff2))['"]?\)/gi;

const MIME_MAP: { [key: string]: string } = {
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.woff2': 'font/woff2',
};

/**
 * 将二进制文件转换为 Base64 Data URI
 * @param filePath 文件的完整路径
 * @returns Base64 Data URI 字符串或 null
 */
const convertAssetToBase64 = async (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_MAP[ext];

    if (!mimeType) return null;

    try {
        const buffer = await fs.readFile(filePath);
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (error) {
        console.error(`❌ Base64 转换失败: ${filePath}`, error);
        return null;
    }
}

/**
 * 混淆/压缩 JS 代码
 * @param code 原始 JS 代码
 * @returns 压缩后的代码字符串或 null
 */
const minifyJsCode = async (code: string) => {
    const options: MinifyOptions = {
        compress: true,
        mangle: true,
        output: { comments: false },
    };

    try {
        const result: MinifyOutput = await terserMinify(code, options);
        return result.code || null;
    } catch (error) {
        console.error('❌ JS 混淆失败:', error);
        return null;
    }
}

/**
 * 优化 CSS 代码 (替换字体引用, 压缩)
 * @param css 原始 CSS 代码
 * @param base64Assets 包含 Base64 URI 的资源 Map
 * @returns 压缩后的代码字符串或 null
 */
const minifyCssCode = (css: string, base64Assets: Map<string, string>) => {
    // 1. 替换 CSS 中的字体文件引用为 Base64 Data URI
    let modifiedCss = css.replace(CSS_URL_REGEX, (match, urlPath) => {
        const fullPath = path.join(TARGET_DIR, urlPath);
        const base64Uri = base64Assets.get(fullPath);

        if (base64Uri) {
            return `url('${base64Uri}')`;
        }
        return match; // 保留原引用
    });

    // 2. 压缩修改后的 CSS 代码
    const result = cleanCss.minify(modifiedCss);

    if (result.errors.length > 0) {
        console.error('❌ CSS 优化失败:', result.errors);
        return null;
    }
    return result.styles;
}

/**
 * 核心合并与优化 HTML 文件
 * @param filePath HTML 文件的完整路径
 * @param externalJsCss 包含 JS/CSS 压缩代码的 Map
 * @param faviconBase64 Favicon 的 Base64 URI 或 null
 */
const embedAndMinifyHtml = async (
    filePath: string,
    externalJsCss: Map<string, string>,
    faviconBase64: string | null
) => {
    let html = await fs.readFile(filePath, 'utf8');

    // 1. 替换外部 JS 文件引用为内联代码
    html = html.replace(JS_REGEX, (match, srcPath) => {
        const fullPath = path.join(path.dirname(filePath), srcPath);
        const code = externalJsCss.get(fullPath);
        return code ? `<script>${code}</script>` : match;
    });

    // 2. 替换外部 CSS 文件引用为内联代码
    html = html.replace(CSS_LINK_REGEX, (match, hrefPath) => {
        const fullPath = path.join(path.dirname(filePath), hrefPath);
        const code = externalJsCss.get(fullPath);
        return code ? `<style>${code}</style>` : match;
    });

    // 3. 替换 Favicon 引用为 Base64 Data URI
    if (faviconBase64) {
        html = html.replace(FAVICON_REGEX, (match, tag, hrefPath) => {
            if (path.basename(hrefPath).toLowerCase() === 'favicon.ico') {
                return tag.replace(`href="${hrefPath}"`, `href="${faviconBase64}"`);
            }
            return match;
        });
    }

    // 4. 优化 HTML 本身 (包括内联 JS/CSS 再次压缩)
    const options: HtmlMinifierOptions = {
        collapseWhitespace: true,
        removeComments: true,
        minifyJS: true,
        minifyCSS: true,
    };

    const result = await htmlMinifierMinify(html, options);

    await fs.writeFile(filePath, result);
    console.log(`\n✅ HTML 合并与优化完成: ${filePath}`);
}

/**
 * 主函数：遍历目录并执行操作
 */
const runMinification = async () => {
    console.log(`开始对目录进行原地处理: ${TARGET_DIR} ...`);

    if (!fs.existsSync(TARGET_DIR) || !fs.existsSync(INDEX_HTML)) {
        console.error(`错误：目标目录 ${TARGET_DIR} 或文件 ${INDEX_HTML} 不存在。`);
        return;
    }

    const base64Assets: Map<string, string> = new Map(); // {fullPath: Base64URI}
    const externalJsCss: Map<string, string> = new Map(); // {fullPath: minifiedCode}
    const assetsToDelete: string[] = [];

    // --- 1. 收集和处理所有外部资源 ---
    const files = await fs.readdir(TARGET_DIR, { withFileTypes: true });

    for (const dirent of files) {
        const fullPath = path.join(TARGET_DIR, dirent.name);
        if (!dirent.isFile()) continue;

        const ext = path.extname(dirent.name).toLowerCase();

        if (/* ext === '.ttf' || ext === '.woff2' || */ ext === '.ico') {
            // A. 字体 / 图标 (Base64 编码)
            const base64Uri = await convertAssetToBase64(fullPath);
            if (base64Uri) {
                base64Assets.set(fullPath, base64Uri);
                assetsToDelete.push(fullPath);
            }
        } else if (ext === '.js') {
            // B. JS (压缩后嵌入 HTML)
            const originalCode = await fs.readFile(fullPath, 'utf8');
            const minifiedCode = await minifyJsCode(originalCode);
            if (minifiedCode) {
                externalJsCss.set(fullPath, minifiedCode);
                assetsToDelete.push(fullPath);
            }
        } else if (ext === '.css') {
            // C. CSS (处理字体引用, 压缩后嵌入 HTML)
            const originalCode = await fs.readFile(fullPath, 'utf8');
            const minifiedCode = minifyCssCode(originalCode, base64Assets);
            if (minifiedCode) {
                externalJsCss.set(fullPath, minifiedCode);
                assetsToDelete.push(fullPath);
            }
        }
    }

    // --- 2. 处理 index.html：嵌入代码并压缩 ---
    const faviconBase64 = base64Assets.get(FAVICON_ICO) || null;
    await embedAndMinifyHtml(INDEX_HTML, externalJsCss, faviconBase64);

    // --- 3. 删除已合并的文件 ---
    const deletePromises = assetsToDelete.map(p => fs.remove(p));
    await Promise.all(deletePromises);
    console.log(`✨ 所有指定文件原地处理完毕！目录 ${TARGET_DIR} 已实现单文件打包。`);
}

runMinification().catch((err) => {
    console.error('致命错误:', err);
});