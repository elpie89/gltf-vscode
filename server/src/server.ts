/* --------------------------------------------------------------------------------------------
 * Some portions copied from lsp-sample:
 * https://github.com/Microsoft/vscode-extension-samples/tree/master/lsp-sample
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
    IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, TextDocument,
    Diagnostic, DiagnosticSeverity, InitializeResult, CompletionItem
    //TextDocumentPositionParams, CompletionItemKind
} from 'vscode-languageserver';
import * as path from 'path';
import * as Url from 'url';
import * as fs from 'fs';
import * as jsonMap from 'json-source-map';
import * as gltfValidator from 'gltf-validator';

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

let documentsToValidate: TextDocument[] = [];
let debounceValidateTimer: NodeJS.Timer;
const debounceTimeout = 500;

function tryGetJsonMap(textDocument: TextDocument) {
    try {
        return jsonMap.parse(textDocument.getText());
    } catch (ex) {
        console.warn('Error parsing glTF document.  Please make sure it is valid JSON.');
    }
    return undefined;
}

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites.
let workspaceRoot: string;
connection.onInitialize((params): InitializeResult => {
    workspaceRoot = params.rootPath;
    return {
        capabilities: {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: documents.syncKind
            // Tell the client that the server support code complete
            //completionProvider: {
            //    resolveProvider: true
            //}
        }
    }
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    scheduleValidation(change.document);
});

// The settings interface describe the server relevant settings part
interface Settings {
    glTF: GltfSettings;
}

interface GltfSettings {
    Validation: ValidatorSettings;
}

interface ValidatorSettings {
    maxNumberOfProblems: number;
}

// hold the maxNumberOfProblems setting
let maxNumberOfProblems: number;
// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((change) => {
    let settings = <Settings>change.settings;
    maxNumberOfProblems = settings.glTF.Validation.maxNumberOfProblems || 100;
    // Schedule revalidation any open text documents
    documents.all().forEach(scheduleValidation);
});

function scheduleValidation(textDocument: TextDocument): void {
    const lowerUri = textDocument.uri.toLowerCase();
    if (lowerUri.startsWith('file:///') && lowerUri.endsWith('.gltf')) {
        console.log('schedule ' + textDocument.uri);
        if (documentsToValidate.indexOf(textDocument) < 0) {
            documentsToValidate.push(textDocument);
        }
        if (debounceValidateTimer) {
            clearTimeout(debounceValidateTimer);
            debounceValidateTimer = undefined;
        }
        debounceValidateTimer = setTimeout(() => {
            documentsToValidate.forEach(validateTextDocument);
            documentsToValidate = [];
        }, debounceTimeout);
    }
}

const _driveLetterPath = /^\/[a-zA-Z]:/;

// From: https://github.com/Microsoft/vscode/blob/f2c2d9c65880e44b588a0e1916423b691fff01d3/src/vs/base/common/uri.ts#L357-L374
function getFsPath(uri) {
    const url = Url.parse(uri);
    const urlPath = decodeURIComponent(url.path);
    let value: string;
    if (url.auth && urlPath && url.protocol === 'file:') {
        // unc path: file://shares/c$/far/boo
        value = `//${url.auth}${urlPath}`;
    } else if (_driveLetterPath.test(urlPath)) {
        // windows drive letter: file:///c:/far/boo
        value = urlPath[1].toLowerCase() + urlPath.substr(2);
    } else {
        // other path
        value = urlPath;
    }
    return path.normalize(value);
}

function validateTextDocument(textDocument: TextDocument): void {
    console.log('validate ' + textDocument.uri);

    const fileName = getFsPath(textDocument.uri);
    const baseName = path.basename(fileName);

    const gltfData = Buffer.from(textDocument.getText());
    const folderName = path.resolve(fileName, '..');

    gltfValidator.validateBytes(baseName, new Uint8Array(gltfData), (uri) =>
        new Promise((resolve, reject) => {
            uri = path.resolve(folderName, uri);
            fs.readFile(uri, (err, data) => {
                console.log("Loading external file: " + uri);
                if (err) {
                    console.warn("Error: " + err.toString());
                    reject(err.toString());
                    return;
                }
                resolve(data);
            });
        })
    ).then((result) => {
        // Validation report in object form
        if (result.errors) {
            const diagnostics = convertErrorsToDiagnostics(textDocument, result.errors);

            // Send the computed diagnostics to VSCode.
            connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
        } else {
            // Clear any old errors.
            const diagnostics: Diagnostic[] = [];
            connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
        }
    }, (result) => {
        // Validator's error
        console.warn('glTF Validator had problems.');
        console.warn(result);
    });
}

connection.onDidChangeWatchedFiles((_change) => {
    // Monitored files have change in VSCode
    connection.console.log('We recevied an file change event');
});


function convertErrorsToDiagnostics(textDocument: TextDocument, errors: any) : Diagnostic[] {
    let diagnostics: Diagnostic[] = [];
    let problems = 0;

    const map = tryGetJsonMap(textDocument);
    if (!map) {
        diagnostics.push(getDiagnostic({ message: 'Error parsing JSON document.' }, {}));
    } else {
        for (let category in errors) {
            if (errors.hasOwnProperty(category)) {
                let errorList = errors[category];
                let len = errorList.length;
                for (let i = 0; i < len; ++i) {
                    let info = errorList[i];
                    if (info.message) {
                        if (++problems > maxNumberOfProblems) {
                            break;
                        }
                        diagnostics.push(getDiagnostic(info, map));
                    }
                }
            }
        }
    }

    return diagnostics;
}

function getDiagnostic(info: any, map: any) : Diagnostic {
    let range = {
        start: { line: 0, character: 0 },
        end: { line: 0, character: Number.MAX_VALUE }
    };

    if (info.path) {
        const pointerName = info.path.substring(1);
        if (map.pointers.hasOwnProperty(pointerName)) {
            const pointer = map.pointers[pointerName];
            const start = pointer.key || pointer.value;
            range.start.line = start.line;
            range.start.character = start.column;

            const end = pointer.valueEnd;
            range.end.line = end.line;
            range.end.character = end.column;
        }
    }

    return {
        code: 'Some code',
        severity: DiagnosticSeverity.Error,
        range,
        message: info.message,
        source: 'glTF Validator'
    };
}

/*
// This handler provides the initial list of the completion items.
connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    return [
        {
            label: 'TypeScript',
            kind: CompletionItemKind.Text,
            data: 1
        },
        {
            label: 'JavaScript',
            kind: CompletionItemKind.Text,
            data: 2
        }
    ]
});
*/

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    if (item.data === 1) {
        item.detail = 'TypeScript details',
            item.documentation = 'TypeScript documentation'
    } else if (item.data === 2) {
        item.detail = 'JavaScript details',
            item.documentation = 'JavaScript documentation'
    }
    return item;
});

/*
connection.onDidOpenTextDocument((params) => {
    // A text document got opened in VSCode.
    // params.uri uniquely identifies the document. For documents store on disk this is a file URI.
    // params.text the initial full content of the document.
    connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
    // The content of a text document did change in VSCode.
    // params.uri uniquely identifies the document.
    // params.contentChanges describe the content changes to the document.
    connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
    // A text document got closed in VSCode.
    // params.uri uniquely identifies the document.
    connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Listen on the connection
connection.listen();