import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Define the structure for a color entry in the map
interface ColorMapEntry {
    name: string;
    oklch: {
        l: number;
        c: number;
        h: number;
    };
}

// Define the structure for parsed OKLCH values
interface ParsedOklch {
    l: number;
    c: number;
    h: number;
    alpha?: number; // Optional numeric alpha value (for hover)
    alphaString?: string; // Optional original alpha string (e.g., " / 15%")
    range: vscode.Range; // Range of the oklch() function in the document
}

let colorMap: ColorMapEntry[] = [];

// Function to load the color map from map.json
function loadColorMap(context: vscode.ExtensionContext) {
    const mapPath = path.join(context.extensionPath, 'src', 'map.json');
    try {
        const mapContent = fs.readFileSync(mapPath, 'utf-8');
        colorMap = JSON.parse(mapContent);
        console.log('OKLCH Color Map loaded successfully.');
    } catch (error) {
        console.error('Failed to load OKLCH Color Map:', error);
        vscode.window.showErrorMessage('Failed to load Tailwind OKLCH color map.');
    }
}


/**
 * Command handler to remove annotations (comments) immediately following OKLCH colors.
 */
async function removeOklchColorAnnotationsHandler() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('No active editor found.');
        return;
    }

    const document = editor.document;
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    const parsedColors = parseOklchFunctionsInRange(document, fullRange);

    if (parsedColors.length === 0) {
        vscode.window.showInformationMessage('No OKLCH colors found.');
        return;
    }

    const edit = new vscode.WorkspaceEdit();
    let commentsRemovedCount = 0;

    // Process colors in reverse order to avoid range shifts
    for (let i = parsedColors.length - 1; i >= 0; i--) {
        const color = parsedColors[i];
        const line = document.lineAt(color.range.end.line);
        const textAfterColor = line.text.substring(color.range.end.character);

        // Regex to find a comment starting immediately after the color (allowing for whitespace)
        const commentMatch = textAfterColor.match(/^(\s*)(\/\*.*?\*\/)/);

        if (commentMatch) {
            // Calculate the range of the comment including leading whitespace
            const commentStartIndex = color.range.end.character + commentMatch[1].length; // Start after whitespace
            const commentEndIndex = commentStartIndex + commentMatch[2].length; // End of the comment text
            const whitespaceStartIndex = color.range.end.character; // Start of whitespace

            const rangeToDelete = new vscode.Range(
                new vscode.Position(color.range.end.line, whitespaceStartIndex), // Include leading whitespace
                new vscode.Position(color.range.end.line, commentEndIndex)
            );

            edit.delete(document.uri, rangeToDelete);
            commentsRemovedCount++;
        }
    }

    if (commentsRemovedCount > 0) {
        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
            vscode.window.showInformationMessage(`Removed ${commentsRemovedCount} OKLCH color annotation(s).`);
        } else {
            vscode.window.showErrorMessage('Failed to remove annotations.');
        }
    } else {
        vscode.window.showInformationMessage('No OKLCH color annotations found to remove.');
    }
}



/**
 * Command handler to annotate all OKLCH colors in the active editor.
 */
async function annotateOklchColorsHandler() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('No active editor found.');
        return;
    }

    const document = editor.document;
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    const parsedColors = parseOklchFunctionsInRange(document, fullRange);

    if (parsedColors.length === 0) {
        vscode.window.showInformationMessage('No OKLCH colors found to annotate.');
        return;
    }

    const edit = new vscode.WorkspaceEdit();

    // Process colors in reverse order to avoid range shifts
    for (let i = parsedColors.length - 1; i >= 0; i--) {
        const color = parsedColors[i];
        const colorName = findColorName(color.l, color.c, color.h);
        let baseCommentText = colorName ? colorName : 'Custom';

        // Add alpha percentage if present and not 100%
        if (color.alpha !== undefined && !approxEqual(color.alpha, 1.0, 0.001)) {
             const alphaPercentage = Math.round(color.alpha * 100);
             baseCommentText += ` / ${alphaPercentage}%`;
        }
        const commentText = ` /* ${baseCommentText} */`;


        const line = document.lineAt(color.range.end.line);
        const textAfterColor = line.text.substring(color.range.end.character);
        const existingCommentMatch = textAfterColor.match(/^\s*(\/\*.*?\*\/)/);

        let positionToInsert = color.range.end;
        let textToInsert = commentText;

        if (existingCommentMatch) {
            // If a comment already exists right after, replace it
            const commentStartIndex = color.range.end.character + textAfterColor.indexOf(existingCommentMatch[1]);
            const commentEndIndex = commentStartIndex + existingCommentMatch[1].length;
            const commentRange = new vscode.Range(
                new vscode.Position(color.range.end.line, commentStartIndex),
                new vscode.Position(color.range.end.line, commentEndIndex)
            );
            // Only replace if the new comment is different
            if (existingCommentMatch[1] !== commentText.trim()) {
                 edit.replace(document.uri, commentRange, commentText.trim()); // Use trim to avoid leading space if replacing
            }
            // If the comment is the same, skip this color
            else {
                continue;
            }

        } else {
            // Otherwise, insert the new comment with a leading space
            edit.insert(document.uri, positionToInsert, textToInsert);
        }
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (success) {
        vscode.window.showInformationMessage(`Annotated ${parsedColors.length} OKLCH color(s).`);
    } else {
        vscode.window.showErrorMessage('Failed to apply annotations.');
    }
}


// Function to compare floating point numbers with a small tolerance
function approxEqual(a: number, b: number, epsilon: number = 0.0001): boolean {
    return Math.abs(a - b) < epsilon;
}

// Function to find the Tailwind color name for given OKLCH values
function findColorName(l: number, c: number, h: number): string | null {
    for (const entry of colorMap) {
        if (approxEqual(entry.oklch.l, l) &&
            approxEqual(entry.oklch.c, c) &&
            approxEqual(entry.oklch.h, h)) {
            return entry.name;
        }
    }
    return null; // No match found
}

// Function to parse oklch() functions in a range
function parseOklchFunctionsInRange(document: vscode.TextDocument, range: vscode.Range): ParsedOklch[] {
    const results: ParsedOklch[] = [];
    const text = document.getText(range);
    // Regex: Capture L, C, H, and optionally the *entire* alpha part (including '/')
    const regex = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(\s*\/\s*[\d.%]+)?\s*\)/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const l = parseFloat(match[1]);
        const c = parseFloat(match[2]);
        const h = parseFloat(match[3]);
        const alphaString = match[4]; // Capture the full alpha part like " / 15%" or " / 0.8"
        let alpha: number | undefined = undefined; // Still parse numeric alpha for hover

        if (alphaString) {
            // Extract the numeric part for alpha calculation
            const alphaValueMatch = alphaString.match(/[\d.%]+/);
            if (alphaValueMatch) {
                const alphaStrNumeric = alphaValueMatch[0];
                 if (alphaStrNumeric.endsWith('%')) {
                    alpha = parseFloat(alphaStrNumeric.slice(0, -1)) / 100;
                } else {
                    alpha = parseFloat(alphaStrNumeric);
                }
            }
        }

        // Check if L, C, H are valid numbers
        if (!isNaN(l) && !isNaN(c) && !isNaN(h)) {
            // Check if alpha is valid if it exists
            if (alphaString && alpha === undefined || (alpha !== undefined && isNaN(alpha))) {
                 // If alphaString exists but parsing failed, skip this match
                 continue;
            }

            const matchStartOffset = match.index;
            const matchEndOffset = matchStartOffset + match[0].length;
            const absoluteStartOffset = document.offsetAt(range.start) + matchStartOffset;
            const absoluteEndOffset = document.offsetAt(range.start) + matchEndOffset;
            const startPos = document.positionAt(absoluteStartOffset);
            const endPos = document.positionAt(absoluteEndOffset);
            const oklchRange = new vscode.Range(startPos, endPos);
            // Store both numeric alpha (for hover) and original alpha string (for replacement)
            results.push({ l, c, h, alpha, alphaString, range: oklchRange });
        }
    }
    return results;
}

/**
 * Command handler to show Quick Pick and replace color.
 */
// Accept originalAlphaString instead of numeric alpha
async function selectColorHandler(documentUri: vscode.Uri, targetRange: vscode.Range, originalAlphaString: string | undefined) {
    // Get the active document to check for existing comments
    const document = await vscode.workspace.openTextDocument(documentUri);
    if (!document) {
        console.error("Could not open document:", documentUri.toString());
        return; // Should not happen if the command was invoked from a valid context
    }

    const quickPickItems = colorMap.map(entry => ({
        label: entry.name,
        description: `oklch(${entry.oklch.l} ${entry.oklch.c} ${entry.oklch.h})`,
        entry: entry
    }));

    const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
        matchOnDescription: true,
        placeHolder: 'Select Tailwind color name or search by oklch values'
    });

    if (selectedItem) {
        const selectedEntry = selectedItem.entry;
        let replacementString = `oklch(${selectedEntry.oklch.l} ${selectedEntry.oklch.c} ${selectedEntry.oklch.h}`;

        // Append the original alpha string directly if it existed
        if (originalAlphaString !== undefined) {
            replacementString += originalAlphaString;
        }
        replacementString += ')';

        const edit = new vscode.WorkspaceEdit();
        const rangeToReplace = new vscode.Range(
            new vscode.Position(targetRange.start.line, targetRange.start.character),
            new vscode.Position(targetRange.end.line, targetRange.end.character)
        );

        // --- Check for and update existing comment ---
        const line = document.lineAt(targetRange.end.line);
        const textAfterColor = line.text.substring(targetRange.end.character);
        const commentMatch = textAfterColor.match(/^(\s*)(\/\*.*?\*\/)/);

        if (commentMatch) {
            const whitespaceLength = commentMatch[1].length;
            const commentTextLength = commentMatch[2].length;
            const commentStartChar = targetRange.end.character + whitespaceLength;
            const commentEndChar = commentStartChar + commentTextLength;

            const existingCommentRange = new vscode.Range(
                new vscode.Position(targetRange.end.line, commentStartChar),
                new vscode.Position(targetRange.end.line, commentEndChar)
            );

            let newCommentBaseText = selectedItem.label; // Use the selected color's name

            // --- Add alpha to the new comment if original had alpha ---
            let originalNumericAlpha: number | undefined = undefined;
            if (originalAlphaString) {
                const alphaValueMatch = originalAlphaString.match(/[\d.%]+/);
                if (alphaValueMatch) {
                    const alphaStrNumeric = alphaValueMatch[0];
                    if (alphaStrNumeric.endsWith('%')) {
                        originalNumericAlpha = parseFloat(alphaStrNumeric.slice(0, -1)) / 100;
                    } else {
                        originalNumericAlpha = parseFloat(alphaStrNumeric);
                    }
                }
            }

            if (originalNumericAlpha !== undefined && !approxEqual(originalNumericAlpha, 1.0, 0.001)) {
                const alphaPercentage = Math.round(originalNumericAlpha * 100);
                newCommentBaseText += ` / ${alphaPercentage}%`;
            }
            // --- End alpha addition ---

            const newCommentText = `/* ${newCommentBaseText} */`;

            // Replace the existing comment text
            edit.replace(documentUri, existingCommentRange, newCommentText);
        }
        // --- End of comment update ---

        // Replace the color value itself
        edit.replace(documentUri, rangeToReplace, replacementString);

        // Apply both edits (color replacement and potential comment replacement)
        await vscode.workspace.applyEdit(edit);
    }
}


/**
 * Provides Code Actions (Quick Fixes) for changing OKLCH colors.
 */
export class OklchColorActionProvider implements vscode.CodeActionProvider {

    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {

        const currentLine = document.lineAt(range.start.line);
        const parsedColorsOnLine = parseOklchFunctionsInRange(document, currentLine.range);
        let targetColor: ParsedOklch | null = null;

        for (const parsedColor of parsedColorsOnLine) {
            if (range instanceof vscode.Selection) {
                 if (parsedColor.range.intersection(range)) { targetColor = parsedColor; break; }
            } else if (parsedColor.range.contains(range)) {
                targetColor = parsedColor; break;
            }
        }

        if (!targetColor) {
            return [];
        }

        const action = new vscode.CodeAction('Replace with a Tailwind color', vscode.CodeActionKind.QuickFix);
        action.command = {
            command: 'tailwind-color-reader.selectColor',
            title: 'Replace with a Tailwind color',
            tooltip: 'Opens a searchable list to select a Tailwind color.',
            arguments: [
                document.uri,
                { // Pass range data
                    start: { line: targetColor.range.start.line, character: targetColor.range.start.character },
                    end: { line: targetColor.range.end.line, character: targetColor.range.end.character }
                },
                // Pass the original alpha string
                targetColor.alphaString
            ]
        };
        action.isPreferred = true;

        return [action];
    }
}


// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "tailwind-color-reader" is now active!');

    loadColorMap(context);

    // Register Command - update signature to accept alphaString
    context.subscriptions.push(
        vscode.commands.registerCommand('tailwind-color-reader.selectColor',
            (documentUri: vscode.Uri, targetRangeData: { start: { line: number, character: number }, end: { line: number, character: number } }, originalAlphaString: string | undefined) => {
                const targetRange = new vscode.Range(
                    new vscode.Position(targetRangeData.start.line, targetRangeData.start.character),
                    new vscode.Position(targetRangeData.end.line, targetRangeData.end.character)
                );
                // Call handler with alphaString
                selectColorHandler(documentUri, targetRange, originalAlphaString);
            }
        )
    );

    // Register Hover Provider (uses numeric alpha, no change needed here)
    let hoverProvider = vscode.languages.registerHoverProvider('css', {
        provideHover(document, position, token) {
            const line = document.lineAt(position.line);
            const parsedColors = parseOklchFunctionsInRange(document, line.range);

            for (const color of parsedColors) {
                if (color.range.contains(position)) {
                    const colorName = findColorName(color.l, color.c, color.h);
                    if (colorName) {
                        let hoverText = `**${colorName}**`;
                        // Hover still uses numeric alpha for display consistency
                        if (color.alpha !== undefined) {
                            const alphaPercentage = Math.round(color.alpha * 100);
                            if (alphaPercentage !== 100) {
                                hoverText += ` / ${alphaPercentage}%`;
                            }
                        }
                        const markdown = new vscode.MarkdownString(hoverText);
                        return new vscode.Hover(markdown, color.range);
                    } else {
                        return null;
                    }
                }
            }
            return null;
        }
    });
    context.subscriptions.push(hoverProvider);

    // Register Code Action Provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('css', new OklchColorActionProvider(), {
            providedCodeActionKinds: OklchColorActionProvider.providedCodeActionKinds
        })
    );

    // Register the new annotation command
    context.subscriptions.push(
        vscode.commands.registerCommand('tailwind-color-reader.annotateColors', annotateOklchColorsHandler)
    );

    // Register the annotation removal command
    context.subscriptions.push(
        vscode.commands.registerCommand('tailwind-color-reader.removeColorAnnotations', removeOklchColorAnnotationsHandler)
    );
}

// This method is called when your extension is deactivated
export function deactivate() { }
