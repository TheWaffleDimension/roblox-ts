import * as ts from "ts-morph";
import {
	checkMethodReserved,
	checkReserved,
	inheritsFromRoact,
	ROACT_COMPONENT_TYPE,
	ROACT_DERIVED_CLASSES_ERROR,
	ROACT_PURE_COMPONENT_TYPE,
	transpileAccessorDeclaration,
	transpileConstructorDeclaration,
	transpileExpression,
	transpileMethodDeclaration,
	transpileRoactClassDeclaration,
} from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { shouldHoist } from "../typeUtilities";
import { bold } from "../utility";

const LUA_RESERVED_METAMETHODS = [
	"__index",
	"__newindex",
	"__add",
	"__sub",
	"__mul",
	"__div",
	"__mod",
	"__pow",
	"__unm",
	"__eq",
	"__lt",
	"__le",
	"__call",
	"__concat",
	"__tostring",
	"__len",
	"__metatable",
	"__mode",
];

const LUA_UNDEFINABLE_METAMETHODS = ["__index", "__newindex", "__mode"];

function getClassMethod(
	classDec: ts.ClassDeclaration | ts.ClassExpression,
	methodName: string,
): ts.MethodDeclaration | undefined {
	const method = classDec.getMethod(methodName);
	if (method) {
		return method;
	}
	const baseClass = classDec.getBaseClass();
	if (baseClass) {
		const baseMethod = getClassMethod(baseClass, methodName);
		if (baseMethod) {
			return baseMethod;
		}
	}
	return undefined;
}

// TODO: remove
function getConstructor(node: ts.ClassDeclaration | ts.ClassExpression) {
	for (const constructor of node.getConstructors()) {
		return constructor;
	}
}

function transpileClass(state: TranspilerState, node: ts.ClassDeclaration | ts.ClassExpression) {
	const name = node.getName() ? [node.getName()!] : state.getNewId();
	const nameNode = node.getNameNode();
	if (nameNode) {
		checkReserved(name.join(""), nameNode, true);
	}

	if (ts.TypeGuards.isClassDeclaration(node)) {
		state.pushExport(name, node);
	}

	// Roact checks
	const baseTypes = node.getBaseTypes();
	for (const baseType of baseTypes) {
		const baseTypeText = baseType.getText();

		// Handle the special case where we have a roact class
		if (baseTypeText.startsWith(ROACT_COMPONENT_TYPE)) {
			return transpileRoactClassDeclaration(state, "Component", name, node);
		} else if (baseTypeText.startsWith(ROACT_PURE_COMPONENT_TYPE)) {
			return transpileRoactClassDeclaration(state, "PureComponent", name, node);
		}

		if (inheritsFromRoact(baseType)) {
			throw new TranspilerError(
				`Cannot inherit ${bold(baseTypeText)}, must inherit ${bold("Roact.Component")}\n` +
					ROACT_DERIVED_CLASSES_ERROR,
				node,
				TranspilerErrorType.RoactSubClassesNotSupported,
			);
		}
	}

	const extendExp = node.getExtends();
	let baseClassName = new Array<string>();
	let hasSuper = false;
	if (extendExp) {
		hasSuper = true;
		baseClassName = transpileExpression(state, extendExp.getExpression());
	}

	const isExpression = ts.TypeGuards.isClassExpression(node);

	const result = new Array<string>();
	if (isExpression) {
		result.push("(function()\n");
	} else {
		if (nameNode && shouldHoist(node, nameNode)) {
			state.pushHoistStack(name);
		} else {
			result.push(state.indent, "local ", ...name, ";\n");
		}
		result.push(state.indent, "do\n");
	}
	state.pushIndent();

	if (hasSuper) {
		result.push(state.indent, "local super = ", ...baseClassName, ";\n");
	}

	let hasStaticMembers = false;

	let prefix = "";
	if (isExpression) {
		prefix = "local ";
	}

	if (hasSuper) {
		result.push(state.indent, prefix, ...name, " = setmetatable({");
	} else {
		result.push(state.indent, prefix, ...name, " = {");
	}

	state.pushIndent();

	node.getStaticMethods()
		.filter(method => method.getBody() !== undefined)
		.forEach(method => {
			if (!hasStaticMembers) {
				hasStaticMembers = true;
				result.push("\n");
			}
			result.push(...transpileMethodDeclaration(state, method));
		});

	state.popIndent();

	if (hasSuper) {
		result.push(hasStaticMembers ? state.indent : "", "}, { __index = super });\n");
	} else {
		result.push(hasStaticMembers ? state.indent : "", "};\n");
	}

	if (hasSuper) {
		result.push(state.indent, ...name, ".__index = setmetatable({");
	} else {
		result.push(state.indent, ...name, ".__index = {");
	}

	state.pushIndent();
	let hasIndexMembers = false;

	const extraInitializers = new Array<Array<string>>();
	const instanceProps = node
		.getInstanceProperties()
		// @ts-ignore
		.filter(prop => prop.getParent() === node)
		.filter(prop => !ts.TypeGuards.isGetAccessorDeclaration(prop))
		.filter(prop => !ts.TypeGuards.isSetAccessorDeclaration(prop));
	for (const prop of instanceProps) {
		const propNameNode = prop.getNameNode();
		if (propNameNode) {
			let propStr: Array<string>;
			if (ts.TypeGuards.isIdentifier(propNameNode)) {
				const propName = propNameNode.getText();
				propStr = [".", propName];
				checkMethodReserved(propName, prop);
			} else if (ts.TypeGuards.isStringLiteral(propNameNode)) {
				const expStr = transpileExpression(state, propNameNode);
				checkMethodReserved(propNameNode.getLiteralText(), prop);
				propStr = ["[", ...expStr, "]"];
			} else if (ts.TypeGuards.isNumericLiteral(propNameNode)) {
				const expStr = transpileExpression(state, propNameNode);
				propStr = ["[", ...expStr, "]"];
			} else {
				// ComputedPropertyName
				const computedExp = propNameNode.getExpression();
				if (ts.TypeGuards.isStringLiteral(computedExp)) {
					checkMethodReserved(computedExp.getLiteralText(), prop);
				}
				const computedExpStr = transpileExpression(state, computedExp);
				propStr = ["[", ...computedExpStr, "]"];
			}

			if (ts.TypeGuards.isInitializerExpressionableNode(prop)) {
				const initializer = prop.getInitializer();
				if (initializer) {
					extraInitializers.push([
						"self",
						...propStr,
						" = ",
						...transpileExpression(state, initializer),
						";\n",
					]);
				}
			}
		}
	}

	node.getInstanceMethods()
		.filter(method => method.getBody() !== undefined)
		.forEach(method => {
			if (!hasIndexMembers) {
				hasIndexMembers = true;
				result.push("\n");
			}
			result.push(...transpileMethodDeclaration(state, method));
		});

	state.popIndent();

	if (hasSuper) {
		result.push(hasIndexMembers ? state.indent : "", "}, super);\n");
	} else {
		result.push(hasIndexMembers ? state.indent : "", "};\n");
	}

	LUA_RESERVED_METAMETHODS.forEach(metamethod => {
		if (getClassMethod(node, metamethod)) {
			if (LUA_UNDEFINABLE_METAMETHODS.indexOf(metamethod) !== -1) {
				throw new TranspilerError(
					`Cannot use undefinable Lua metamethod as identifier '${metamethod}' for a class`,
					node,
					TranspilerErrorType.UndefinableMetamethod,
				);
			}
			result.push(
				state.indent,
				...name,
				".",
				metamethod,
				" = function(self, ...) return self:",
				metamethod,
				"(...); end;\n",
			);
		}
	});

	if (!node.isAbstract()) {
		result.push(state.indent, ...name, ".new = function(...)\n");
		state.pushIndent();
		result.push(state.indent, "return ", ...name, ".constructor(setmetatable({}, ", ...name, "), ...);\n");
		state.popIndent();
		result.push(state.indent, "end;\n");
	}

	result.push(...transpileConstructorDeclaration(state, name, getConstructor(node), extraInitializers, hasSuper));

	for (const prop of node.getStaticProperties()) {
		const propNameNode = prop.getNameNode();
		if (propNameNode) {
			let propStr: Array<string>;
			if (ts.TypeGuards.isIdentifier(propNameNode)) {
				const propName = propNameNode.getText();
				propStr = [".", propName];
				checkMethodReserved(propName, prop);
			} else if (ts.TypeGuards.isStringLiteral(propNameNode)) {
				const expStr = transpileExpression(state, propNameNode);
				checkMethodReserved(propNameNode.getLiteralText(), prop);
				propStr = ["[", ...expStr, "]"];
			} else if (ts.TypeGuards.isNumericLiteral(propNameNode)) {
				const expStr = transpileExpression(state, propNameNode);
				propStr = ["[", ...expStr, "]"];
			} else {
				// ComputedPropertyName
				const computedExp = propNameNode.getExpression();
				if (ts.TypeGuards.isStringLiteral(computedExp)) {
					checkMethodReserved(computedExp.getLiteralText(), prop);
				}
				const computedExpStr = transpileExpression(state, computedExp);
				propStr = ["[", ...computedExpStr, "]"];
			}
			let propValue = ["nil"];
			if (ts.TypeGuards.isInitializerExpressionableNode(prop)) {
				const initializer = prop.getInitializer();
				if (initializer) {
					propValue = transpileExpression(state, initializer);
				}
			}
			result.push(state.indent, ...name, ...propStr, " = ", ...propValue, ";\n");
		}
	}

	const getters = node
		.getInstanceProperties()
		.filter((prop): prop is ts.GetAccessorDeclaration => ts.TypeGuards.isGetAccessorDeclaration(prop));
	let ancestorHasGetters = false;
	let ancestorClass: ts.ClassDeclaration | ts.ClassExpression | undefined = node;
	while (!ancestorHasGetters && ancestorClass !== undefined) {
		ancestorClass = ancestorClass.getBaseClass();
		if (ancestorClass !== undefined) {
			const ancestorGetters = ancestorClass
				.getInstanceProperties()
				.filter((prop): prop is ts.GetAccessorDeclaration => ts.TypeGuards.isGetAccessorDeclaration(prop));
			if (ancestorGetters.length > 0) {
				ancestorHasGetters = true;
			}
		}
	}

	if (getters.length > 0 || ancestorHasGetters) {
		if (getters.length > 0) {
			const getterContent = new Array<string>();
			state.pushIndent();
			for (const getter of getters) {
				getterContent.push(...transpileAccessorDeclaration(state, getter, [getter.getName()]));
			}
			state.popIndent();
			getterContent.push(state.indent);
			if (ancestorHasGetters) {
				result.push(
					state.indent,
					...name,
					"._getters = setmetatable({",
					...getterContent,
					"}, { __index = super._getters });\n",
				);
			} else {
				result.push(state.indent, ...name, "._getters = {\n", ...getterContent, "};\n");
			}
		} else {
			result.push(state.indent, ...name, "._getters = super._getters;\n");
		}
		result.push(state.indent, "local __index = ", ...name, ".__index;\n");
		result.push(state.indent, ...name, ".__index = function(self, index)\n");
		state.pushIndent();
		result.push(state.indent, "local getter = ", ...name, "._getters[index];\n");
		result.push(state.indent, "if getter then\n");
		state.pushIndent();
		result.push(state.indent, "return getter(self);\n");
		state.popIndent();
		result.push(state.indent, "else\n");
		state.pushIndent();
		result.push(state.indent, "return __index[index];\n");
		state.popIndent();
		result.push(state.indent, "end;\n");
		state.popIndent();
		result.push(state.indent, "end;\n");
	}

	const setters = node
		.getInstanceProperties()
		.filter((prop): prop is ts.SetAccessorDeclaration => ts.TypeGuards.isSetAccessorDeclaration(prop));
	let ancestorHasSetters = false;
	ancestorClass = node;
	while (!ancestorHasSetters && ancestorClass !== undefined) {
		ancestorClass = ancestorClass.getBaseClass();
		if (ancestorClass !== undefined) {
			const ancestorSetters = ancestorClass
				.getInstanceProperties()
				.filter((prop): prop is ts.GetAccessorDeclaration => ts.TypeGuards.isSetAccessorDeclaration(prop));
			if (ancestorSetters.length > 0) {
				ancestorHasSetters = true;
			}
		}
	}
	if (setters.length > 0 || ancestorHasSetters) {
		if (setters.length > 0) {
			const setterContent = new Array<string>();
			state.pushIndent();
			for (const setter of setters) {
				setterContent.push(...transpileAccessorDeclaration(state, setter, [setter.getName()]));
			}
			state.popIndent();
			setterContent.push(state.indent);
			if (ancestorHasSetters) {
				result.push(
					state.indent + name,
					"._setters = setmetatable({",
					...setterContent,
					"}, { __index = super._setters });\n",
				);
			} else {
				result.push(state.indent, ...name, "._setters = {", ...setterContent, "};\n");
			}
		} else {
			result.push(state.indent, ...name, "._setters = super._setters;\n");
		}
		result.push(state.indent, ...name, ".__newindex = function(self, index, value)\n");
		state.pushIndent();
		result.push(state.indent, "local setter = ", ...name, "._setters[index];\n");
		result.push(state.indent, "if setter then\n");
		state.pushIndent();
		result.push(state.indent, "setter(self, value);\n");
		state.popIndent();
		result.push(state.indent, "else\n");
		state.pushIndent();
		result.push(state.indent, "rawset(self, index, value);\n");
		state.popIndent();
		result.push(state.indent, "end;\n");
		state.popIndent();
		result.push(state.indent, "end;\n");
	}

	if (isExpression) {
		result.push(state.indent, "return ", ...name, ";\n");
		state.popIndent();
		result.push(state.indent, "end)()");
	} else {
		state.popIndent();
		result.push(state.indent, "end;\n");
	}

	return result;
}

export function transpileClassDeclaration(state: TranspilerState, node: ts.ClassDeclaration) {
	return transpileClass(state, node);
}

export function transpileClassExpression(state: TranspilerState, node: ts.ClassExpression) {
	return transpileClass(state, node);
}
