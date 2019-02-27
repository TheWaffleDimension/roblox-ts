import * as path from "path";
import * as ts from "ts-morph";
import { checkReserved, transpileExpression } from ".";
import { CompilerError, CompilerErrorType } from "../errors/CompilerError";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { isRbxService, isUsedAsType } from "../typeUtilities";
import { addSeparatorAndFlatten, isValidLuaIdentifier, stripExtensions } from "../utility";

function isDefinitionALet(def: ts.DefinitionInfo<ts.ts.DefinitionInfo>) {
	const parent = def.getNode().getParent();
	if (parent && ts.TypeGuards.isVariableDeclaration(parent)) {
		const grandparent = parent.getParent();
		return (
			ts.TypeGuards.isVariableDeclarationList(grandparent) &&
			grandparent.getDeclarationKind() === ts.VariableDeclarationKind.Let
		);
	}
	return false;
}

function shouldLocalizeImport(namedImport: ts.Identifier) {
	for (const definition of namedImport.getDefinitions()) {
		if (isDefinitionALet(definition)) {
			return false;
		}
	}
	return true;
}

function getRelativeImportPath(
	state: TranspilerState,
	sourceFile: ts.SourceFile,
	moduleFile: ts.SourceFile | undefined,
	specifier: string,
	node: ts.ImportDeclaration | ts.ExportDeclaration | ts.ImportEqualsDeclaration,
) {
	const currentPartition = state.syncInfo.find(part => part.dir.isAncestorOf(sourceFile));
	const modulePartition = moduleFile && state.syncInfo.find(part => part.dir.isAncestorOf(moduleFile));

	if (moduleFile && currentPartition && currentPartition.target !== (modulePartition && modulePartition.target)) {
		return getImportPathFromFile(state, sourceFile, moduleFile, node);
	}

	const parts = path.posix
		.normalize(specifier)
		.split("/")
		.filter(part => part !== ".")
		.map(part => (part === ".." ? ".Parent" : part));
	if (parts[parts.length - 1] === ".index") {
		parts.pop();
	}
	let prefix = "script";
	if (stripExtensions(sourceFile.getBaseName()) !== "index") {
		prefix += ".Parent";
	}

	const importParts = parts.filter(p => p !== ".Parent");
	const params = [
		prefix,
		parts.filter(p => p === ".Parent").join(""),
		...(importParts.length > 0 ? [`, "`, importParts.join('", "'), `"`] : [""]),
	];

	state.usesTSLibrary = true;
	return ["TS.import(", ...params, ")"];
}

const moduleCache = new Map<string, string>();

function getImportPathFromFile(
	state: TranspilerState,
	sourceFile: ts.SourceFile,
	moduleFile: ts.SourceFile,
	node: ts.ImportDeclaration | ts.ExportDeclaration | ts.ImportEqualsDeclaration,
) {
	if (state.modulesDir && state.modulesDir.isAncestorOf(moduleFile)) {
		let parts = state.modulesDir
			.getRelativePathTo(moduleFile)
			.split("/")
			.filter(part => part !== ".");

		const moduleName = parts.shift();
		if (!moduleName) {
			throw new CompilerError("Compiler.getImportPath() failed! #1", CompilerErrorType.GetImportPathFail1);
		}

		let mainPath: string;
		if (moduleCache.has(moduleName)) {
			mainPath = moduleCache.get(moduleName)!;
		} else {
			const pkgJson = require(path.join(state.modulesDir.getPath(), moduleName, "package.json"));
			mainPath = pkgJson.main as string;
			moduleCache.set(moduleName, mainPath);
		}

		parts = mainPath.split(/[\\/]/g);
		let last = parts.pop();
		if (!last) {
			throw new CompilerError("Compiler.getImportPath() failed! #2", CompilerErrorType.GetImportPathFail2);
		}
		last = stripExtensions(last);
		if (last !== "init") {
			parts.push(last);
		}

		parts = parts
			.filter(part => part !== ".")
			.map(part => (isValidLuaIdentifier(part) ? "." + part : `["${part}"]`));

		state.usesTSLibrary = true;
		const params = `TS.getModule("${moduleName}", script.Parent)` + parts.join("");
		return ["require(", params, ")"];
	} else {
		const partition = state.syncInfo.find(part => part.dir.isAncestorOf(moduleFile));
		if (!partition) {
			throw new CompilerError(
				"Could not compile non-relative import, no data from rojo.json",
				CompilerErrorType.NoRojoData,
			);
		}

		const parts = partition.dir
			.getRelativePathAsModuleSpecifierTo(moduleFile)
			.split("/")
			.filter(part => part !== ".");

		const last = parts.pop();
		if (!last) {
			throw new CompilerError("Compiler.getImportPath() failed! #3", CompilerErrorType.GetImportPathFail3);
		}

		if (last !== "index") {
			parts.push(last);
		}

		const params = partition.target
			.split(".")
			.concat(parts)
			.filter(v => v.length > 0)
			.map((v, i) => (i === 0 ? v : `"${v}"`));

		const rbxService = params[0];
		if (rbxService && isRbxService(rbxService)) {
			params[0] = `game:GetService("${params[0]}")`;
		} else {
			throw new TranspilerError(
				rbxService + " is not a valid Roblox Service!",
				node,
				TranspilerErrorType.InvalidService,
			);
		}

		state.usesTSLibrary = true;
		return ["TS.import(", params.join(", "), ")"];
	}
}

export function transpileImportDeclaration(state: TranspilerState, node: ts.ImportDeclaration): string[] {
	const defaultImport = node.getDefaultImport();
	const namespaceImport = node.getNamespaceImport();
	const namedImports = node.getNamedImports();

	const isSideEffect = !defaultImport && !namespaceImport && namedImports.length === 0;

	if (
		!isSideEffect &&
		(!namespaceImport || isUsedAsType(namespaceImport)) &&
		(!defaultImport || isUsedAsType(defaultImport)) &&
		namedImports.every(namedImport => isUsedAsType(namedImport.getNameNode()))
	) {
		return [];
	}

	let luaPath: Array<string>;
	if (node.isModuleSpecifierRelative()) {
		luaPath = getRelativeImportPath(
			state,
			node.getSourceFile(),
			node.getModuleSpecifierSourceFile(),
			node.getModuleSpecifier().getLiteralText(),
			node,
		);
	} else {
		const moduleFile = node.getModuleSpecifierSourceFile();
		if (moduleFile) {
			luaPath = getImportPathFromFile(state, node.getSourceFile(), moduleFile, node);
		} else {
			const specifierText = node.getModuleSpecifier().getLiteralText();
			throw new TranspilerError(
				`Could not find file for '${specifierText}'. Did you forget to "npm install"?`,
				node,
				TranspilerErrorType.MissingModuleFile,
			);
		}
	}

	const result = new Array<string>();
	if (isSideEffect) {
		return [...luaPath, ";\n"];
	}

	const lhs = new Array<string>();
	const rhs = new Array<string>();
	const unlocalizedImports = new Array<string>();

	if (defaultImport && !isUsedAsType(defaultImport)) {
		const definitions = defaultImport.getDefinitions();
		const exportAssignments =
			definitions.length > 0 &&
			definitions[0]
				.getNode()
				.getSourceFile()
				.getExportAssignments();

		const defaultImportExp = transpileExpression(state, defaultImport);

		if (exportAssignments && exportAssignments.length === 1 && exportAssignments[0].isExportEquals()) {
			// If the defaultImport is importing an `export = ` statement,
			return ["local ", ...defaultImportExp, " = ", ...luaPath, ";\n"];
		}

		lhs.push(...defaultImportExp);
		rhs.push("._default");
		unlocalizedImports.push("");
	}

	if (namespaceImport && !isUsedAsType(namespaceImport)) {
		lhs.push(...transpileExpression(state, namespaceImport));
		rhs.push("");
		unlocalizedImports.push("");
	}

	let rhsPrefix: Array<string>;
	let hasVarNames = false;

	namedImports
		.filter(namedImport => !isUsedAsType(namedImport.getNameNode()))
		.forEach(namedImport => {
			const aliasNode = namedImport.getAliasNode();
			const name = namedImport.getName();
			const alias = aliasNode ? aliasNode.getText() : name;
			const shouldLocalize = shouldLocalizeImport(namedImport.getNameNode());

			// keep these here no matter what, so that exports can take from initial state.
			checkReserved(alias, node, true);
			lhs.push(alias);
			rhs.push(`.${name}`);

			if (shouldLocalize) {
				unlocalizedImports.push("");
			} else {
				hasVarNames = true;
				unlocalizedImports.push(alias);
			}
		});

	if (rhs.length === 1 && !hasVarNames) {
		rhsPrefix = luaPath;
	} else {
		rhsPrefix = state.getNewId();
		result.push("local ", ...rhsPrefix, " = ", ...luaPath, ";\n");
	}

	for (let i = 0; i < unlocalizedImports.length; i++) {
		const alias = unlocalizedImports[i];
		if (alias !== "") {
			state.variableAliases.set(alias, [...rhsPrefix, rhs[i]]);
		}
	}

	if (hasVarNames || lhs.length > 0) {
		const lhsStr = lhs.join(", ");
		const rhsStr = rhs.map(v => rhsPrefix + v).join(", ");

		if (lhsStr === "Roact") {
			state.hasRoactImport = true;
		}
		result.push("local ", lhsStr, " = ", rhsStr, ";\n");
	}

	return result;
}

export function transpileImportEqualsDeclaration(state: TranspilerState, node: ts.ImportEqualsDeclaration) {
	const nameNode = node.getNameNode();
	if (isUsedAsType(nameNode)) {
		return [];
	}

	let luaPath: Array<string>;
	const moduleFile = node.getExternalModuleReferenceSourceFile();
	if (moduleFile) {
		if (node.isExternalModuleReferenceRelative()) {
			let specifier: string;
			const moduleReference = node.getModuleReference();
			if (ts.TypeGuards.isExternalModuleReference(moduleReference)) {
				const exp = moduleReference.getExpressionOrThrow() as ts.StringLiteral;
				specifier = exp.getLiteralText();
			} else {
				throw new TranspilerError("Bad specifier", node, TranspilerErrorType.BadSpecifier);
			}
			luaPath = getRelativeImportPath(state, node.getSourceFile(), moduleFile, specifier, node);
		} else {
			luaPath = getImportPathFromFile(state, node.getSourceFile(), moduleFile, node);
		}
	} else {
		const text = node.getModuleReference().getText();
		throw new TranspilerError(`Could not find file for '${text}'`, node, TranspilerErrorType.MissingModuleFile);
	}

	const name = node.getName();

	if (name === "Roact") {
		state.hasRoactImport = true;
	}

	return [state.indent, `local `, name, ` = `, ...luaPath, `;\n`];
}

export function transpileExportDeclaration(state: TranspilerState, node: ts.ExportDeclaration) {
	let luaImportStr = new Array<string>();
	const moduleSpecifier = node.getModuleSpecifier();
	if (moduleSpecifier) {
		if (node.isModuleSpecifierRelative()) {
			luaImportStr = getRelativeImportPath(
				state,
				node.getSourceFile(),
				node.getModuleSpecifierSourceFile(),
				moduleSpecifier.getLiteralText(),
				node,
			);
		} else {
			const moduleFile = node.getModuleSpecifierSourceFile();
			if (moduleFile) {
				luaImportStr = getImportPathFromFile(state, node.getSourceFile(), moduleFile, node);
			} else {
				const specifierText = moduleSpecifier.getLiteralText();
				throw new TranspilerError(
					`Could not find file for '${specifierText}'. Did you forget to "npm install"?`,
					node,
					TranspilerErrorType.MissingModuleFile,
				);
			}
		}
	}

	const ancestor =
		node.getFirstAncestorByKind(ts.SyntaxKind.ModuleDeclaration) ||
		node.getFirstAncestorByKind(ts.SyntaxKind.SourceFile);

	if (!ancestor) {
		throw new TranspilerError("Could not find export ancestor!", node, TranspilerErrorType.BadAncestor);
	}

	const lhs = new Array<string>();
	const rhs = new Array<string>();

	if (node.isNamespaceExport()) {
		state.usesTSLibrary = true;
		let ancestorName: string;
		if (ts.TypeGuards.isNamespaceDeclaration(ancestor)) {
			ancestorName = ancestor.getName();
		} else {
			state.isModule = true;
			ancestorName = "_exports";
		}
		return [state.indent, "TS.exportNamespace(", ...luaImportStr, "}, ", ancestorName, "});\n"];
	} else {
		const namedExports = node.getNamedExports().filter(namedExport => !isUsedAsType(namedExport.getNameNode()));
		if (namedExports.length === 0) {
			return [];
		}

		let ancestorName: string;
		if (ts.TypeGuards.isNamespaceDeclaration(ancestor)) {
			ancestorName = ancestor.getName();
		} else {
			state.isModule = true;
			ancestorName = "_exports";
		}

		namedExports.forEach(namedExport => {
			const aliasNode = namedExport.getAliasNode();
			let name = namedExport.getNameNode().getText();
			if (name === "default") {
				name = "_default";
			}
			const alias = aliasNode ? aliasNode.getText() : name;
			checkReserved(alias, node);
			lhs.push(alias);
			if (luaImportStr.length > 0) {
				rhs.push(`.${name}`);
			} else {
				rhs.push(...state.getAlias([name]));
			}
		});

		const result = new Array<string>();
		let rhsPrefix = new Array<string>();
		const lhsPrefix = [ancestorName, "."];
		if (luaImportStr.length > 0) {
			if (rhs.length <= 1) {
				rhsPrefix = luaImportStr;
			} else {
				rhsPrefix = state.getNewId();
				result.push(state.indent, `local `, ...rhsPrefix, ` = `, ...luaImportStr, `;\n`);
			}
		}
		const lhsStr = lhs.map(v => [...lhsPrefix, v]);
		const rhsStr = rhs.map(v => [...rhsPrefix, v]);
		result.push(...addSeparatorAndFlatten(lhsStr, ", "), ` = `, ...addSeparatorAndFlatten(rhsStr, ", "), `;\n`);
		return result;
	}
}

export function transpileExportAssignment(state: TranspilerState, node: ts.ExportAssignment) {
	const result = [state.indent];
	const exp = node.getExpression();
	if (node.isExportEquals() && (!ts.TypeGuards.isIdentifier(exp) || !isUsedAsType(exp))) {
		state.isModule = true;
		const expStr = transpileExpression(state, exp);
		result.push(`_exports = ${expStr};\n`);
	} else {
		const symbol = node.getSymbol();
		if (symbol) {
			if (symbol.getName() === "default") {
				state.isModule = true;
				result.push("_exports._default = ", ...(transpileExpression(state, exp) + ";\n"));
			}
		}
	}
	return result;
}
