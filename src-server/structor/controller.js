/*
 * Copyright 2015 Alexander Pustovalov
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';
import {sortBy, forOwn} from 'lodash';
import express from 'express';
import rewrite from 'express-urlrewrite';
import httpProxy from 'http-proxy';
import {config, storage, commons, gengine} from 'structor-commons';
import * as gengineManager from '../commons/gengine';
import * as clientManager from '../commons/clientManager.js';
import * as middlewareCompilerManager from './middlewareCompilerManager.js';
import * as sandboxCompilerManager from './sandboxCompilerManager.js';
import * as extractManager from './extractManager.js';

export const STRUCTOR_URLS = [
	'/structor',
	'/structor-invoke',
	'/structor-sandbox',
	'/structor-deskpage',
	'/structor-dev',
	'/structor-desk',
	'/structor-sandbox-preview',
	'/structor-sandbox-screenshot',
	'/structor-gengine-scaffolds'
];

let serverRef = undefined;
let proxy = undefined;

export function loopback(options) {
	return Promise.resolve('Response: ' + options.message);
}

export function error(options) {
	return Promise.reject('Response: ' + options.message);
}

export function setServer(server) {
	serverRef = server;
	if (config.status() === config.READY) {
		initServer();
		initProxyServer();
	}
}

function initServer() {
	if (serverRef) {
		serverRef.app.use(middlewareCompilerManager.getDevMiddleware());
		serverRef.app.use(middlewareCompilerManager.getHotMiddleware());
		serverRef.app.use(middlewareCompilerManager.getBuilderMiddleware({
			callback: stats => {
				if (serverRef.ioSocketClient) {
					serverRef.ioSocketClient.emit('compiler.message', stats);
				}
			}
		}));
		serverRef.app.use(rewrite('/structor-deskpage/*', '/structor-desk/index.html'));
		serverRef.app.use('/structor-desk', express.static(config.deskDirPath()));
		serverRef.app.use('/structor-gengine-scaffolds', express.static(config.scaffoldsDirPath()));
	}
}

function initProxyServer() {
	if (serverRef) {
		if (!proxy && config.projectProxyURL()) {
			proxy = httpProxy.createProxyServer({});
			proxy.on('error', (err, req, res) => {
				const statusText = 'Proxy server error connecting to ' + config.projectProxyURL() + req.url + " " + (err.message ? err.message : err);
				res.writeHead(500, statusText);
				res.end(statusText);
				console.error(statusText);
			});
			proxy.on('proxyReq', () => {
				let projectProxyURL = config.projectProxyURL();
				if (projectProxyURL) {
					const proxyURL = projectProxyURL.replace('http://', '');
					return (proxyReq, req, res, options) => {
						proxyReq.setHeader('X-Forwarded-Host', proxyURL);
					}
				}
			});
			//
			serverRef.app.all('/*', (req, res, next) => {
				let url = req.url;
				if (checkDeniedProxyURL(url)) {
					next('route');
				} else {
					let proxyURL = config.projectProxyURL();
					if (proxyURL && proxyURL.length > 0) {
						proxy.web(req, res, {target: proxyURL});
					} else {
						next('route');
					}
				}
			});
		}
	}
}

function checkDeniedProxyURL(textUrl) {
	let isDenied = false;
	if (textUrl) {
		for (let i = 0; i < STRUCTOR_URLS.length; i++) {
			if (textUrl.indexOf(STRUCTOR_URLS[i]) === 0) {
				isDenied = true;
				break;
			}
		}
	}
	return isDenied;
}

export function getModel() {
	return storage.readProjectJsonModel();
}

export function getConfig() {
	return Promise.resolve(config.asObject());
}

export function getProjectStatus() {
	return Promise.resolve(config.status());
}

export function setProxyURL(options) {
	return config.projectProxyURL(options.proxyURL)
		.then(() => {
			initProxyServer();
		});
}

export function getComponentTree() {
	return storage.getComponentTree();
}

export function writeComponentDefaults(options) {
	const {componentName, namespace, defaults} = options;
	return storage.writeComponentDefaults(componentName, namespace, defaults);
}

export function getComponentNotes(options) {
	return storage.readComponentDocument(options.componentName, options.namespace);
}

export function getComponentSourceCode(options) {
	return storage.readComponentSourceCode(options.filePath);
}

export function writeComponentSourceCode(options) {
	return storage.writeComponentSourceCode(options.filePath, options.sourceCode);
}

export function saveProjectModel(options) {
	return storage.writeProjectJsonModel(options.model);
}

export function initUserCredentialsByToken(options) {
	return clientManager.initUserCredentialsByToken(options.token);
}

export function initUserCredentials(options) {
	return clientManager.initUserCredentials(options.username, options.password);
}

export function removeUserCredentials(options) {
	return clientManager.removeAuthToken();
}

export function getProjectsGallery() {
	return clientManager.getAllProjects();
}

export function pregenerate(options) {
	const {generatorName, generatorDirPath, namespace, componentName, model} = options;
	let generatorData = {
		namespace,
		componentName,
		model,
		project: config.getProjectConfig(),
	};
	return storage.getComponentTree()
		.then(index => {
			generatorData.index = index;
			return gengineManager.preProcess(generatorDirPath, generatorData);
		});
}

export function generate(options) {
	const {generatorName, generatorDirPath, namespace, componentName, model, metadata} = options;
	let generatorData = {
		namespace,
		componentName,
		model,
		metadata,
		project: config.getProjectConfig(),
	};
	return storage.getComponentTree()
		.then(index => {
			generatorData.index = index;
			return gengineManager.process(generatorDirPath, generatorData);
		});
}

export function generateApplication(options) {
	const generatorDirPath = config.applicationGeneratorDirPath();
	const {pagesModel, hasApplicationFiles} = options;
	let generatorData = {
		pagesModel,
		hasApplicationFiles,
		project: config.getProjectConfig(),
	};
	return storage.getComponentTree()
		.then(index => {
			generatorData.index = index;
			return gengineManager.process(generatorDirPath, generatorData);
		})
		.then(generatedObject => {
			const {files, dependencies} = generatedObject;
			return storage.saveGenerated(dependencies, files);
		});
}

export function saveGenerated(options) {
	const {files, dependencies} = options;
	return storage.saveGenerated(dependencies, files);
}

export function preExtractNamespaces(options) {
	const {namespaces} = options;
	return extractManager.getAllDependencies(namespaces);
}

export function extractNamespaces(options) {
	const {namespaces, dependencies, dirPath} = options;
	return extractManager.extractNamespaces(namespaces, dependencies, dirPath);
}

export function preInstall(options) {

	let existingNamespaceDirs = [];
	let namespacesSrcDirPath;

	const {dirPath, url} = options;

	let modulesSrcDirPath;
	let namespacesMeta;
	let componentTree;
	let startPromise;

	if (dirPath) {
		namespacesSrcDirPath = dirPath;
		startPromise = Promise.resolve();
	} else if (url) {
		// todo: download and unpack from GH
		startPromise = Promise.resolve();
	}
	return startPromise
		.then(() => {
			modulesSrcDirPath = path.join(namespacesSrcDirPath, 'modules');
			return commons.readJson(path.join(namespacesSrcDirPath, 'structor-namespaces.json'))
		})
		.then(metaObj => {
			namespacesMeta = metaObj;
		})
		.then(() => {
			return storage.getComponentTree()
				.then(tree => {
					componentTree = tree;
				});
		})
		.then(() => {
			return commons.readDirectoryFlat(modulesSrcDirPath)
				.then(foundFiles => {
					const {dirs} = foundFiles;
					if (!dirs || dirs.length <= 0) {
						throw Error('Modules directory is empty');
					}
					return dirs;
				})
		})
		.then((modulesDirs) => {
			modulesDirs.forEach(module => {
				if (componentTree.modules && componentTree.modules[module.name]) {
					existingNamespaceDirs.push(module.name);
				}
			});
		})
		.then(() => {
			return {
				namespacesSrcDirPath,
				existingNamespaceDirs,
			};
		});
}

export function installFromLocalDir(options) {
	const {dirPath} = options;
	const namespacesFilePath = path.join(dirPath, 'structor-namespaces.json');
	const modulesSrcDirPath = path.join(dirPath, 'modules');
	const defaultsSrcDirPath = path.join(dirPath, 'defaults');
	const docsSrcDirPath = path.join(dirPath, 'docs');
	const modulesDestDirPath = path.join(config.appDirPath(), 'modules');
	const defaultsDestDirPath = config.componentDefaultsDirPath();
	const docsDestDirPath = config.docsComponentsDirPath();
	let namespacesMeta;
	let componentTree;
	return commons.readJson(namespacesFilePath)
		.then(metaObj => {
			namespacesMeta = metaObj;
		})
		.then(() => {
			return storage.installDependencies(namespacesMeta.dependencies);
		})
		.then(() => {
			return storage.getComponentTree();
		})
		.then(tree => {
			componentTree = tree;
			let rewriteTasks = [];
			let globalReducerSourceCode = componentTree.reducersSourceCode;
			let globalSagasSourceCode = componentTree.sagasSourceCode;
			let moduleReducerFilePath;
			let moduleSagasFilePath;
			forOwn(namespacesMeta.namespaces, (value, prop) => {
				moduleReducerFilePath = path.join(modulesSrcDirPath, prop, 'reducer.js');
				moduleSagasFilePath = path.join(modulesSrcDirPath, prop, 'sagas.js');
				rewriteTasks.push(
					commons.isExisting(moduleReducerFilePath)
						.then(() => {
							return commons.isExisting(moduleSagasFilePath)
						})
						.then(() => {
							globalReducerSourceCode = gengine.injectReducer(
								globalReducerSourceCode,
								value.reducerPropName,
								`${value.reducerPropName}Reducer`,
								path.join('modules', prop, 'reducer.js')
							);
							globalSagasSourceCode = gengine.injectSaga(
								globalSagasSourceCode,
								`${prop}Sagas`,
								path.join('modules', prop, 'sagas.js')
							);
						})
				);
			});
			return Promise.all(rewriteTasks)
				.then(() => {
					return commons.writeFile(componentTree.reducersFilePath, globalReducerSourceCode);
				})
				.then(() => {
					return commons.writeFile(componentTree.sagasFilePath, globalSagasSourceCode);
				});
		})
		.then(() => {
			return commons.readDirectoryFlat(modulesSrcDirPath)
				.then(foundFiles => {
					const {dirs} = foundFiles;
					if (!dirs || dirs.length <= 0) {
						throw Error('Modules directory is empty');
					}
					return dirs;
				})
		})
		.then(modulesDirs => {
			let copyTasks = [];
			modulesDirs.forEach(module => {
				const destDirPath = path.join(modulesDestDirPath, module.name);
				copyTasks.push(
					commons.removeFile(destDirPath)
						.then(() => {
							return commons.copyFile(module.path, destDirPath);
						})
				);
			});
			return Promise.all(copyTasks);
		})
		.then(() => {
			return commons.readDirectoryFlat(defaultsSrcDirPath)
				.then(foundFiles => {
					const {dirs} = foundFiles;
					if (!dirs || dirs.length <= 0) {
						throw Error('Defaults directory is empty');
					}
					return dirs;
				})
		})
		.then(defaultsDirs => {
			let copyTasks = [];
			let componentsIndexSourceCode = componentTree.indexSourceCode;
			defaultsDirs.forEach(dirItem => {
				const destDirPath = path.join(defaultsDestDirPath, dirItem.name);
				copyTasks.push(
					commons.removeFile(destDirPath)
						.then(() => {
							return commons.copyFile(dirItem.path, destDirPath);
						})
						.then(() => {
							componentsIndexSourceCode = gengine.injectNamespaceComponent(
								componentsIndexSourceCode,
								dirItem.name,
								path.join('modules', dirItem.name)
							);
							return commons.writeFile(
								componentTree.indexFilePath,
								componentsIndexSourceCode
							);
						})
				);
			});
			return Promise.all(copyTasks);
		})
		.then(() => {
			return commons.readDirectoryFlat(docsSrcDirPath)
				.then(foundFiles => {
					const {dirs} = foundFiles;
					if (!dirs || dirs.length <= 0) {
						throw Error('Docs directory is empty');
					}
					return dirs;
				})
		})
		.then(docsDirs => {
			let copyTasks = [];
			docsDirs.forEach(dirItem => {
				const destDirPath = path.join(docsDestDirPath, dirItem.name);
				copyTasks.push(
					commons.removeFile(destDirPath)
						.then(() => {
							return commons.copyFile(dirItem.path, destDirPath);
						})
				);
			});
			return Promise.all(copyTasks);
		});
}

export function getScaffoldGenerators(options) {
	const scaffoldsUrlPrefix = '/structor-gengine-scaffolds';
	const rootDir = config.scaffoldsDirPath();
	return storage.getScaffoldGenerators()
		.then(generators => {
			if (generators && generators.length > 0) {
				generators.forEach(generator => {
					generator.screenshotFilePath = generator.screenshotFilePath.replace(rootDir, scaffoldsUrlPrefix)
				});
				generators = sortBy(generators, ['name']);
			}
			return generators;
		});
}