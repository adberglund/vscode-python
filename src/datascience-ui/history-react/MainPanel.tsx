// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import './mainPanel.css';

import { min } from 'lodash';
import * as React from 'react';

import { CellMatcher } from '../../client/datascience/cellMatcher';
import { generateMarkdownFromCodeLines } from '../../client/datascience/common';
import { HistoryMessages, IHistoryMapping } from '../../client/datascience/history/historyTypes';
import { CellState, ICell, IHistoryInfo, IJupyterVariable } from '../../client/datascience/types';
import { IMessageHandler, PostOffice } from '../react-common/postOffice';
import { getSettings, updateSettings } from '../react-common/settingsReactSide';
import { StyleInjector } from '../react-common/styleInjector';
import { Cell, ICellViewModel } from './cell';
import { ContentPanel, IContentPanelProps } from './contentPanel';
import { HeaderPanel, IHeaderPanelProps } from './headerPanel';
import { InputHistory } from './inputHistory';
import { createCellVM, createEditableCellVM, extractInputText, generateTestState, IMainPanelState } from './mainPanelState';
import { VariableExplorer } from './variableExplorer';

export interface IMainPanelProps {
    skipDefault?: boolean;
    testMode?: boolean;
    baseTheme: string;
    codeTheme: string;
}

export class MainPanel extends React.Component<IMainPanelProps, IMainPanelState> implements IMessageHandler {
    private stackLimit = 10;
    private updateCount = 0;
    private renderCount = 0;
    private editCellRef: Cell | null = null;
    private mainPanel: HTMLDivElement | null = null;
    private variableExplorerRef: React.RefObject<VariableExplorer>;
    private styleInjectorRef: React.RefObject<StyleInjector>;

    // tslint:disable-next-line:max-func-body-length
    constructor(props: IMainPanelProps, _state: IMainPanelState) {
        super(props);

        // Default state should show a busy message
        this.state = { cellVMs: [], busy: true, undoStack: [], redoStack : [], submittedText: false, history: new InputHistory(), contentTop: 24 };

        // Add test state if necessary
        if (!this.props.skipDefault) {
            this.state = generateTestState(this.inputBlockToggled);
        }

        // Add a single empty cell if it's supported
        if (getSettings && getSettings().allowInput) {
            this.state.cellVMs.push(createEditableCellVM(1));
        }

        // Create the ref to hold our variable explorer
        this.variableExplorerRef = React.createRef<VariableExplorer>();

        // Create the ref to hold our style injector
        this.styleInjectorRef = React.createRef<StyleInjector>();
    }

    public componentWillMount() {
        // Add ourselves as a handler for the post office
        PostOffice.addHandler(this);

        // Tell the history code we have started.
        PostOffice.sendMessage<IHistoryMapping, 'started'>(HistoryMessages.Started);
    }

    public componentDidUpdate(_prevProps: Readonly<IMainPanelProps>, _prevState: Readonly<IMainPanelState>, _snapshot?: {}) {
        // If in test mode, update our outputs
        if (this.props.testMode) {
            this.updateCount = this.updateCount + 1;
        }
    }

    public componentWillUnmount() {
        // Remove ourselves as a handler for the post office
        PostOffice.removeHandler(this);
    }

    public render() {

        // If in test mode, update our outputs
        if (this.props.testMode) {
            this.renderCount = this.renderCount + 1;
        }

        const baseTheme = this.computeBaseTheme();

        const headerProps = this.getHeaderProps(baseTheme);
        const contentProps = this.getContentProps(baseTheme);

        return (
            <div id='main-panel' ref={this.updateSelf}>
                <StyleInjector expectingDark={baseTheme !== 'vscode-light'} darkChanged={this.darkChanged} ref={this.styleInjectorRef} />
                <HeaderPanel {...headerProps} />
                <ContentPanel {...contentProps} />
            </div>
        );
    }

    // tslint:disable-next-line:no-any
    public handleMessage = (msg: string, payload?: any) => {
        switch (msg) {
            case HistoryMessages.StartCell:
                this.startCell(payload);
                return true;

            case HistoryMessages.FinishCell:
                this.finishCell(payload);
                return true;

            case HistoryMessages.UpdateCell:
                this.updateCell(payload);
                return true;

            case HistoryMessages.GetAllCells:
                this.getAllCells();
                return true;

            case HistoryMessages.ExpandAll:
                this.expandAllSilent();
                return true;

            case HistoryMessages.CollapseAll:
                this.collapseAllSilent();
                return true;

            case HistoryMessages.DeleteAllCells:
                this.clearAllSilent();
                return true;

            case HistoryMessages.Redo:
                this.redo();
                return true;

            case HistoryMessages.Undo:
                this.undo();
                return true;

            case HistoryMessages.StartProgress:
                if (!this.props.testMode) {
                    this.setState({busy: true});
                }
                break;

            case HistoryMessages.StopProgress:
                if (!this.props.testMode) {
                    this.setState({busy: false});
                }
                break;

            case HistoryMessages.UpdateSettings:
                this.updateSettings(payload);
                break;

            case HistoryMessages.Activate:
                this.activate();
                break;

            case HistoryMessages.GetVariablesResponse:
                this.getVariablesResponse(payload);
                break;

            case HistoryMessages.GetVariableValueResponse:
                this.getVariableValueResponse(payload);
                break;

            default:
                break;
        }

        return false;
    }

    // Uncomment this to use for debugging messages. Add a call to this to stick in dummy sys info messages.
    // private addDebugMessageCell(message: string) {
    //     const cell: ICell = {
    //         id: '0',
    //         file: '',
    //         line: 0,
    //         state: CellState.finished,
    //         data: {
    //             cell_type: 'sys_info',
    //             version: '0.0.0.0',
    //             notebook_version: '0',
    //             path: '',
    //             message: message,
    //             connection: '',
    //             source: '',
    //             metadata: {}
    //         }
    //     };
    //     this.addCell(cell);
    // }

    // Called by the header control when size changes (such as expanding variables)
    private onHeaderHeightChange = (newHeight: number) => {
        this.setState({contentTop: newHeight});
    }

    private darkChanged = (newDark: boolean) => {
        // update our base theme
        this.setState(
            {
                forceDark: newDark
            }
        );
    }

    private computeBaseTheme(): string {
        // If we're ignoring, always light
        if (getSettings && getSettings().ignoreVscodeTheme) {
            return 'vscode-light';
        }

        // Otherwise see if the style injector has figured out
        // the theme is dark or not
        if (this.state.forceDark !== undefined) {
            return this.state.forceDark ? 'vscode-dark' : 'vscode-light';
        }

        return this.props.baseTheme;
    }

    private getContentProps = (baseTheme: string): IContentPanelProps => {
        return {
            baseTheme: baseTheme,
            contentTop: this.state.contentTop,
            cellVMs: this.state.cellVMs,
            history: this.state.history,
            testMode: this.props.testMode,
            codeTheme: this.props.codeTheme,
            submittedText: this.state.submittedText,
            saveEditCellRef: this.saveEditCellRef,
            gotoCellCode: this.gotoCellCode,
            deleteCell: this.deleteCell,
            submitInput: this.submitInput,
            skipNextScroll: this.state.skipNextScroll ? true : false
        };
    }
    private getHeaderProps = (baseTheme: string): IHeaderPanelProps => {
       return {
        addMarkdown: this.addMarkdown,
        busy: this.state.busy,
        collapseAll: this.collapseAll,
        expandAll: this.expandAll,
        export: this.export,
        restartKernel: this.restartKernel,
        interruptKernel: this.interruptKernel,
        undo: this.undo,
        redo: this.redo,
        clearAll: this.clearAll,
        skipDefault: this.props.skipDefault,
        showDataExplorer: this.showDataViewer,
        testMode: this.props.testMode,
        variableExplorerRef: this.variableExplorerRef,
        canCollapseAll: this.canCollapseAll(),
        canExpandAll: this.canExpandAll(),
        canExport: this.canExport(),
        canUndo: this.canUndo(),
        canRedo: this.canRedo(),
        refreshVariables: this.refreshVariables,
        onHeightChange: this.onHeaderHeightChange,
        baseTheme: baseTheme
       };
    }

    private activate() {
        // Make sure the input cell gets focus
        if (getSettings && getSettings().allowInput) {
            // Delay this so that we make sure the outer frame has focus first.
            setTimeout(() => {
                // First we have to give ourselves focus (so that focus actually ends up in the code cell)
                if (this.mainPanel) {
                    this.mainPanel.focus({preventScroll: true});
                }

                if (this.editCellRef) {
                    this.editCellRef.giveFocus();
                }
            }, 100);
        }
    }

    // tslint:disable-next-line:no-any
    private updateSettings = (payload?: any) => {
        if (payload) {
            const prevShowInputs = getSettings().showCellInputCode;
            updateSettings(payload as string);

            // If our settings change updated show inputs we need to fix up our cells
            const showInputs = getSettings().showCellInputCode;

            if (prevShowInputs !== showInputs) {
                this.toggleCellInputVisibility(showInputs, getSettings().collapseCellInputCodeByDefault);
            }
        }
    }

    private showDataViewer = () => {
        this.sendMessage(HistoryMessages.ShowDataViewer, 'df');
    }

    private sendMessage<M extends IHistoryMapping, T extends keyof M>(type: T, payload?: M[T]) {
        PostOffice.sendMessage<M, T>(type, payload);
    }

    private getAllCells = () => {
        // Send all of our cells back to the other side
        const cells = this.state.cellVMs.map((cellVM : ICellViewModel) => {
            return cellVM.cell;
        });

        this.sendMessage(HistoryMessages.ReturnAllCells, cells);
    }

    private saveEditCellRef = (ref: Cell | null) => {
        this.editCellRef = ref;
    }

    private addMarkdown = () => {
        this.addCell({
            data :         {
                cell_type: 'markdown',
                metadata: {},
                source: [
                    '## Cell 3\n',
                    'Here\'s some markdown\n',
                    '- A List\n',
                    '- Of Items'
                ]
            },
            id : '1111',
            file : 'foo.py',
            line : 0,
            state : CellState.finished
        });
    }

    private getNonEditCellVMs() : ICellViewModel [] {
        return this.state.cellVMs.filter(c => !c.editable);
    }

    private canCollapseAll = () => {
        return this.getNonEditCellVMs().length > 0;
    }

    private canExpandAll = () => {
        return this.getNonEditCellVMs().length > 0;
    }

    private canExport = () => {
        return this.getNonEditCellVMs().length > 0;
    }

    private canRedo = () => {
        return this.state.redoStack.length > 0 ;
    }

    private canUndo = () => {
        return this.state.undoStack.length > 0 ;
    }

    private pushStack = (stack : ICellViewModel[][], cells : ICellViewModel[]) => {
        // Get the undo stack up to the maximum length
        const slicedUndo = stack.slice(0, min([stack.length, this.stackLimit]));

        // Combine this with our set of cells
        return [...slicedUndo, cells];
    }

    private gotoCellCode = (index: number) => {
        // Find our cell
        const cellVM = this.state.cellVMs[index];

        // Send a message to the other side to jump to a particular cell
        this.sendMessage(HistoryMessages.GotoCodeCell, { file : cellVM.cell.file, line: cellVM.cell.line });
    }

    private deleteCell = (index: number) => {
        this.sendMessage(HistoryMessages.DeleteCell);

        // Update our state
        this.setState({
            cellVMs: this.state.cellVMs.filter((_c : ICellViewModel, i: number) => {
                return i !== index;
            }),
            undoStack : this.pushStack(this.state.undoStack, this.state.cellVMs),
            skipNextScroll: true
        });
    }

    private collapseAll = () => {
        this.sendMessage(HistoryMessages.CollapseAll);
        this.collapseAllSilent();
    }

    private expandAll = () => {
        this.sendMessage(HistoryMessages.ExpandAll);
        this.expandAllSilent();
    }

    private clearAll = () => {
        this.sendMessage(HistoryMessages.DeleteAllCells);
        this.clearAllSilent();
    }

    private clearAllSilent = () => {
        // Make sure the edit cell doesn't go away
        const editCell = this.getEditCell();

        // Update our state
        this.setState({
            cellVMs: editCell ? [editCell] : [],
            undoStack : this.pushStack(this.state.undoStack, this.state.cellVMs),
            skipNextScroll: true,
            busy: false // No more progress on delete all
        });

        // Tell other side, we changed our number of cells
        this.sendInfo();
    }

    private redo = () => {
        // Pop one off of our redo stack and update our undo
        const cells = this.state.redoStack[this.state.redoStack.length - 1];
        const redoStack = this.state.redoStack.slice(0, this.state.redoStack.length - 1);
        const undoStack = this.pushStack(this.state.undoStack, this.state.cellVMs);
        this.sendMessage(HistoryMessages.Redo);
        this.setState({
            cellVMs: cells,
            undoStack: undoStack,
            redoStack: redoStack,
            skipNextScroll: true
        });

        // Tell other side, we changed our number of cells
        this.sendInfo();
    }

    private undo = () => {
        // Pop one off of our undo stack and update our redo
        const cells = this.state.undoStack[this.state.undoStack.length - 1];
        const undoStack = this.state.undoStack.slice(0, this.state.undoStack.length - 1);
        const redoStack = this.pushStack(this.state.redoStack, this.state.cellVMs);
        this.sendMessage(HistoryMessages.Undo);
        this.setState({
            cellVMs: cells,
            undoStack : undoStack,
            redoStack : redoStack,
            skipNextScroll : true
        });

        // Tell other side, we changed our number of cells
        this.sendInfo();
    }

    private restartKernel = () => {
        // Send a message to the other side to restart the kernel
        this.sendMessage(HistoryMessages.RestartKernel);
    }

    private interruptKernel = () => {
        // Send a message to the other side to restart the kernel
        this.sendMessage(HistoryMessages.Interrupt);
    }

    private export = () => {
        // Send a message to the other side to export our current list
        const cellContents: ICell[] = this.state.cellVMs.map((cellVM: ICellViewModel, _index: number) => { return cellVM.cell; });
        this.sendMessage(HistoryMessages.Export, cellContents);
    }

    private updateSelf = (r: HTMLDivElement) => {
        this.mainPanel = r;
    }

    // tslint:disable-next-line:no-any
    private addCell = (payload?: any) => {
        // Get our settings for if we should display input code and if we should collapse by default
        const showInputs = getSettings().showCellInputCode;
        const collapseInputs = getSettings().collapseCellInputCodeByDefault;

        if (payload) {
            const cell = payload as ICell;
            let cellVM: ICellViewModel = createCellVM(cell, getSettings(), this.inputBlockToggled);

            // Set initial cell visibility and collapse
            cellVM = this.alterCellVM(cellVM, showInputs, !collapseInputs);

            if (cellVM) {
                let newList : ICellViewModel[] = [];

                // Insert before the edit cell if we have one
                const editCell = this.getEditCell();
                if (editCell) {
                    newList = [...this.state.cellVMs.filter(c => !c.editable), cellVM, editCell];

                    // Update execution count on the last cell
                    editCell.cell.data.execution_count = this.getInputExecutionCount(newList);
                } else {
                    newList = [...this.state.cellVMs, cellVM];
                }

                this.setState({
                    cellVMs: newList,
                    undoStack: this.pushStack(this.state.undoStack, this.state.cellVMs),
                    redoStack: this.state.redoStack,
                    skipNextScroll: false
                });

                // Tell other side, we changed our number of cells
                this.sendInfo();
            }
        }
    }

    private getEditCell() : ICellViewModel | undefined {
        const editCells = this.state.cellVMs.filter(c => c.editable);
        if (editCells && editCells.length === 1) {
            return editCells[0];
        }

        return undefined;
    }

    private inputBlockToggled = (id: string) => {
        // Create a shallow copy of the array, let not const as this is the shallow array copy that we will be changing
        const cellVMArray: ICellViewModel[] = [...this.state.cellVMs];
        const cellVMIndex = cellVMArray.findIndex((value: ICellViewModel) => {
            return value.cell.id === id;
        });

        if (cellVMIndex >= 0) {
            // Const here as this is the state object pulled off of our shallow array copy, we don't want to mutate it
            const targetCellVM = cellVMArray[cellVMIndex];

            // Mutate the shallow array copy
            cellVMArray[cellVMIndex] = this.alterCellVM(targetCellVM, true, !targetCellVM.inputBlockOpen);

            this.setState({
                skipNextScroll: true,
                cellVMs: cellVMArray
            });
        }
    }

    private toggleCellInputVisibility = (visible: boolean, collapse: boolean) => {
        this.alterAllCellVMs(visible, !collapse);
    }

    private collapseAllSilent = () => {
        if (getSettings().showCellInputCode) {
            this.alterAllCellVMs(true, false);
        }
    }

    private expandAllSilent = () => {
        if (getSettings().showCellInputCode) {
            this.alterAllCellVMs(true, true);
        }
    }

    private alterAllCellVMs = (visible: boolean, expanded: boolean) => {
        const newCells = this.state.cellVMs.map((value: ICellViewModel) => {
            return this.alterCellVM(value, visible, expanded);
        });

        this.setState({
            skipNextScroll: true,
            cellVMs: newCells
        });
    }

    // Adjust the visibility or collapsed state of a cell
    private alterCellVM = (cellVM: ICellViewModel, visible: boolean, expanded: boolean) => {
        if (cellVM.cell.data.cell_type === 'code') {
            // If we are already in the correct state, return back our initial cell vm
            if (cellVM.inputBlockShow === visible && cellVM.inputBlockOpen === expanded) {
                return cellVM;
            }

            const newCellVM = {...cellVM};
            if (cellVM.inputBlockShow !== visible) {
                if (visible) {
                    // Show the cell, the rest of the function will add on correct collapse state
                    newCellVM.inputBlockShow = true;
                } else {
                    // Hide this cell
                    newCellVM.inputBlockShow = false;
                }
            }

            // No elseif as we want newly visible cells to pick up the correct expand / collapse state
            if (cellVM.inputBlockOpen !== expanded && cellVM.inputBlockCollapseNeeded && cellVM.inputBlockShow) {
                if (expanded) {
                    // Expand the cell
                    const newText = extractInputText(cellVM.cell, getSettings());

                    newCellVM.inputBlockOpen = true;
                    newCellVM.inputBlockText = newText;
                } else {
                    // Collapse the cell
                    let newText = extractInputText(cellVM.cell, getSettings());
                    if (newText.length > 0) {
                        newText = newText.split('\n', 1)[0];
                        newText = newText.slice(0, 255); // Slice to limit length, slicing past length is fine
                        newText = newText.concat('...');
                    }

                    newCellVM.inputBlockOpen = false;
                    newCellVM.inputBlockText = newText;
                }
            }

            return newCellVM;
        }

        return cellVM;
    }

    private sendInfo = () => {
        const info : IHistoryInfo = {
            cellCount: this.getNonEditCellVMs().length,
            undoCount: this.state.undoStack.length,
            redoCount: this.state.redoStack.length
        };
        this.sendMessage(HistoryMessages.SendInfo, info);
    }

    private updateOrAdd = (cell: ICell, allowAdd? : boolean) => {
        const index = this.state.cellVMs.findIndex((c : ICellViewModel) => {
            return c.cell.id === cell.id &&
                   c.cell.line === cell.line &&
                   c.cell.file === cell.file;
            });
        if (index >= 0) {
            // Update this cell
            this.state.cellVMs[index].cell = cell;

            // Also update the last cell execution count. It may have changed
            const editCell = this.getEditCell();
            if (editCell) {
                editCell.cell.data.execution_count = this.getInputExecutionCount(this.state.cellVMs);
            }

            this.forceUpdate();
        } else if (allowAdd) {
            // This is an entirely new cell (it may have started out as finished)
            this.addCell(cell);
        }
    }

    private isCellSupported(cell: ICell) : boolean {
        return !this.props.testMode || cell.data.cell_type !== 'sys_info';
    }

    // tslint:disable-next-line:no-any
    private finishCell = (payload?: any) => {
        if (payload) {
            const cell = payload as ICell;
            if (cell && this.isCellSupported(cell)) {
                this.updateOrAdd(cell, true);
            }
        }

        // When a cell is finished refresh our variables
        if (getSettings && getSettings().showJupyterVariableExplorer) {
            this.refreshVariables();
        }
    }

    // tslint:disable-next-line:no-any
    private startCell = (payload?: any) => {
        if (payload) {
            const cell = payload as ICell;
            if (cell && this.isCellSupported(cell)) {
                this.updateOrAdd(cell, true);
            }
        }
    }

    // tslint:disable-next-line:no-any
    private updateCell = (payload?: any) => {
        if (payload) {
            const cell = payload as ICell;
            if (cell && this.isCellSupported(cell)) {
                this.updateOrAdd(cell, false);
            }
        }
    }

    private getInputExecutionCount(cellVMs: ICellViewModel[]) : number {
        const realCells = cellVMs.filter(c => c.cell.data.cell_type === 'code' && !c.editable && c.cell.data.execution_count);
        return realCells && realCells.length > 0 ? parseInt(realCells[realCells.length - 1].cell.data.execution_count!.toString(), 10) + 1 : 1;
    }

    private submitInput = (code: string) => {
        // This should be from our last entry. Switch this entry to read only, and add a new item to our list
        let editCell = this.getEditCell();
        if (editCell) {
            // Save a copy of the ones without edits.
            const withoutEdits = this.state.cellVMs.filter(c => !c.editable);

            // Change this editable cell to not editable.
            editCell.cell.state = CellState.executing;
            editCell.cell.data.source = code;

            // Change type to markdown if necessary
            const split = code.splitLines({trim: false});
            const firstLine = split[0];
            const matcher = new CellMatcher(getSettings());
            if (matcher.isMarkdown(firstLine)) {
                editCell.cell.data.cell_type = 'markdown';
                editCell.cell.data.source = generateMarkdownFromCodeLines(split);
                editCell.cell.state = CellState.finished;
            }

            // Update input controls (always show expanded since we just edited it.)
            editCell = createCellVM(editCell.cell, getSettings(), this.inputBlockToggled);
            const collapseInputs = getSettings().collapseCellInputCodeByDefault;
            editCell = this.alterCellVM(editCell, true, !collapseInputs);

            // Indicate this is direct input so that we don't hide it if the user has
            // hide all inputs turned on.
            editCell.directInput = true;

            // Stick in a new cell at the bottom that's editable and update our state
            // so that the last cell becomes busy
            this.setState({
                cellVMs: [...withoutEdits, editCell, createEditableCellVM(this.getInputExecutionCount(withoutEdits))],
                undoStack : this.pushStack(this.state.undoStack, this.state.cellVMs),
                redoStack: this.state.redoStack,
                skipNextScroll: false,
                submittedText: true
            });

            // Send a message to execute this code if necessary.
            if (editCell.cell.state !== CellState.finished) {
                this.sendMessage(HistoryMessages.SubmitNewCell, { code, id: editCell.cell.id });
            }
        }
    }

    // When the variable explorer wants to refresh state (say if it was expanded)
    private refreshVariables = () => {
        this.sendMessage(HistoryMessages.GetVariablesRequest);
    }

    // Find the display value for one specific variable
    private refreshVariable = (targetVar: IJupyterVariable) => {
        this.sendMessage(HistoryMessages.GetVariableValueRequest, targetVar);
    }

    // When we get a variable value back use the ref to pass to the variable explorer
    // tslint:disable-next-line:no-any
    private getVariableValueResponse = (payload?: any) => {
        if (payload) {
            const variable = payload as IJupyterVariable;

            if (this.variableExplorerRef.current) {
                this.variableExplorerRef.current.newVariableData(variable);
            }
        }
    }

    // When we get our new set of variables back use the ref to pass to the variable explorer
    // tslint:disable-next-line:no-any
    private getVariablesResponse = (payload?: any) => {
        if (payload) {
            const variables = payload as IJupyterVariable[];

            if (this.variableExplorerRef.current) {
                this.variableExplorerRef.current.newVariablesData(variables);
            }

            // Now put out a request for all of the sub values for the variables
            variables.forEach(this.refreshVariable);
        }
    }
}
