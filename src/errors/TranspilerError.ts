import * as ts from "ts-morph";

export enum TranspilerErrorType {
	NoAny,
	ReservedKeyword,
	ReservedMethodName,
	SpreadDestructuring,
	ParameterChildMissing,
	NoLabeledStatement,
	BadStatement,
	MissingModuleFile,
	BadSpecifier,
	BadAncestor,
	UnexpectedBindingPattern,
	UnexpectedInitializer,
	ForEmptyVarName,
	NoVarKeyword,
	UndefinableMetamethod,
	NoConstructorReturn,
	NoThisOutsideClass,
	NoNull,
	BadExpression,
	BadFunctionBody,
	ExpectedPropertyAccessExpression,
	NoMacroMathExpressionStatement,
	NoEqualsEquals,
	NoExclamationEquals,
	BadBinaryExpression,
	BadPrefixUnaryExpression,
	BadPostfixUnaryExpression,
	InvalidClientOnlyAPIAccess,
	InvalidServerOnlyAPIAccess,
	NoFunctionIndex,
	NoClassPrototype,
	ExportInNonModuleScript,
	RoactGettersNotAllowed,
	RoactSettersNotAllowed,
	RoactSubClassesNotSupported,
	RoactJsxTextNotSupported,
	RoactNoNewComponentAllowed,
	RoactJsxWithoutImport,
	RoactNoReservedMethods,
	RoactInvalidSymbol,
	RoactInvalidPrimitive,
	RoactInvalidExpression,
	RoactInvalidCallExpression,
	RoactInvalidIdentifierExpression,
	RoactInvalidPropertyExpression,
	UnexpectedObjectIndex,
	NoDynamicImport,
	InvalidIdentifier,
	RobloxTSReservedIdentifier,
	BadContext,
	ClassyLoop,
	MixedMethodCall,
	InvalidService,
	ReservedNamespace,
	BadAddition,
	InvalidMacroIndex,
	NoTypeOf,
	BadBuiltinConstructorCall,
	BadForOfInitializer,
	ForInLoop,
	BadDestructuringType,
	NullableIndexOnMapOrSet,
	BadSpreadType,
}

export class TranspilerError extends Error {
	constructor(message: string, public readonly node: ts.Node, public readonly type: TranspilerErrorType) {
		super(message);
	}
}
