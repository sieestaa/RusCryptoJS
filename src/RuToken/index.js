/**
 * RuToken simplified library
 * @author Aleksandr.ru
 * @link http://aleksandr.ru
 */

import rutoken from 'rutoken';
import DN from '../DN';
import errors from './errors';
import { convertDN } from '../helpers';

function RuToken() {
	var plugin, deviceId;

	/**
	 * Инициализация и проверка наличия требуемых возможностей
	 * @returns {Promise<Object>} версия, информация о токене
	 */
	this.init = function(){
		return rutoken.ready.then( _ => {
			if (window.chrome) {
				return rutoken.isExtensionInstalled();
			} else {
				return Promise.resolve(true);
			}
		}).then(result => {
			if (result) {
				return rutoken.isPluginInstalled();
			} else {
				throw new Error("Rutoken Extension wasn't found");
			}
		}).then(result => {
			if (result) {
				return rutoken.loadPlugin();
			} else {
				throw new Error("Rutoken Plugin wasn't found");
			}
		}).then(result => {
			//Можно начинать работать с плагином
			plugin = result;
			return plugin.enumerateDevices();
		}).then(devices => {
			const len = devices.length;
			if (len === 1) {
				deviceId = devices.shift();
			}
			else if(len === 0) {
				throw new Error("Не обнаружено подключенных устройств");
			}
			else if(len > 1) {
				throw new Error('Подключено ' + len + ' устройств');
			}
			return Promise.all([
				plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_READER), // имя считывателя 
				plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_LABEL), // метка токена 					
				plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_SERIAL), // серийный номер токена
				plugin.getDeviceModel(deviceId),
				plugin.getDeviceType(deviceId)
			]);
		}).then(infos => {
			return {
				version: plugin.version,
				serial: infos[2],
				reader: infos[0],
				label: infos[1].indexOf('Rutoken ECP <no label>') + 1 ? '' : infos[1],
				type: infos[4],
				model: infos[3]
			};
		}).then(null, e => {
			const err = getError(e);
			throw new Error(err);
		});
	};

	/**
	 * Авторизация на токене с пин-кодом юзера
	 * @param {string} userPin если нет, то предлгает ввести пин через prompt
	 * @returns {Promise}
	 */
	this.bind = function(userPin) {
		return new Promise((resolve, reject) => {
			plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_IS_LOGGED_IN).then(result => {
				if(result) {
					resolve('Пользователь уже авторизован');
					return false; // no need to log in
				}
				else {
					if (!userPin) {
						userPin = prompt('PIN-код доступа к устройству');
						if (!userPin) throw new Error('Авторизация на устройстве отменена пользователем');
					}
				}
				return true; // need to log in 
			}).then(needToLogIn => {
				if (needToLogIn) {
					return plugin.login(deviceId, userPin).then( _ => {
						resolve(true);
					});
				}
				else {
					resolve(true);
				}
			}).then(null, e => {
				const err = getError(e);
				reject(err);
			});
		});
	};

	/**
	 * Отменить предъявление PIN-кода. Необходимо вызывать при завершении сеанса работы
	 * @returns {Promise}
	 */
	this.unbind = function() {
		return new Promise((resolve, reject) => {
			plugin.getDeviceInfo(deviceId, plugin.TOKEN_INFO_IS_LOGGED_IN).then(result => {
				if(!result) {
					resolve('Пользователь не авторизован');
					return false; // no need to log out
				}
				else {
					return true; // need to log out 
				}
			}).then(needToLogOut => {
				if (needToLogOut) {
					return plugin.logout(deviceId).then( _ => {
						resolve(true);
					});
				}
				else {
					return true;
				}
			}).then(null, e => {
				const err = getError(e);
				reject(err);
			});
		});
	};

	/**
	 * Очистка токена (удаление всех сертификатов и ключей)
	 * @returns {Promise<number>} количество удаленных элементов
	 */
	this.clean = function(){
		let count = 0;
		return plugin.enumerateCertificates(deviceId, plugin.CERT_CATEGORY_USER).then(results => {
			let promises = [];
			for (let i in results) {
				const certId = results[i];
				promises.push(plugin.deleteCertificate(deviceId, certId));
			}
			count += promises.length;
			return Promise.all(promises);
		}).then(() => {
			const marker = ''; // Идентификатор группы ключей, "" - все ключи
			return plugin.enumerateKeys(deviceId, marker);
		}).then(results => {
			let promises = [];
			for (let i in results) {
				const keyId = results[i];
				promises.push(plugin.deleteKeyPair(deviceId, keyId));
			}
			count += promises.length;
			return Promise.all(promises);
		}).then(() => {
			return count;
		}).then(null, e => {
			const err = getError(e);
			throw new Error(err);
		});
	};

	/**
	 * Создать запрос на сертификат
	 * @param {DN} dn
	 * @param {string} marker Идентификатор группы ключей
	 * @param {array} extKeyUsage массив OID Extended Key Usage, по-умолчанию Аутентификация клиента '1.3.6.1.5.5.7.3.2' + Защищенная электронная почта '1.3.6.1.5.5.7.3.4'
	 * @param {string} algorithm Алгоритм "PUBLIC_KEY_ALGORITHM_GOST3410_2012_256" (по-умолчанию) или "PUBLIC_KEY_ALGORITHM_GOST3410_2001".
	 * @returns {Promise<Object>} объект с полями { csr: 'base64 запрос на сертификат', containerId }
	 * @see DN
	 */
	this.generateCSR = function(dn, marker, extKeyUsage, algorithm){
		let keyId = '';
		if (!marker) {
			marker = '';
		}
		if (!extKeyUsage || !extKeyUsage.length) {
			extKeyUsage = [
				'clientAuth', // 1.3.6.1.5.5.7.3.2', // Аутентификация клиента
				'emailProtection', // '1.3.6.1.5.5.7.3.4' // Защищенная электронная почта
			];
		}
		const publicKeyAlgorithm = algorithm && plugin[algorithm] || plugin.PUBLIC_KEY_ALGORITHM_GOST3410_2012_256;
		let paramset = 'XA';
		let hashAlgorithm = plugin.HASH_TYPE_GOST3411_94;
		if (publicKeyAlgorithm === plugin.PUBLIC_KEY_ALGORITHM_GOST3410_2012_512) {
			paramset = 'A';
			hashAlgorithm = plugin.HASH_TYPE_GOST3411_12_512;
		} 
		else if (publicKeyAlgorithm === plugin.PUBLIC_KEY_ALGORITHM_GOST3410_2012_256) {
			hashAlgorithm = plugin.HASH_TYPE_GOST3411_12_256;
		}
		const reserved = undefined;
		const options = {
			publicKeyAlgorithm,
			paramset
		};
		return plugin.generateKeyPair(deviceId, reserved, marker, options).then(result => {
			keyId = result;
			let subject = [];
			for (let i in dn) if(dn.hasOwnProperty(i)) {
				subject.push({
					rdn: i,
					value: dn[i]
				});
			}
			const keyUsage = [
				"digitalSignature"
				,"nonRepudiation"
				,"keyEncipherment"
				,"dataEncipherment"
			];
			const extensions = {
				keyUsage,
				extKeyUsage
			};
			const subjectSignTool = 'СКЗИ "РУТОКЕН ЭЦП"';
			const options = {
				subjectSignTool,
				hashAlgorithm
			};
			return plugin.createPkcs10(deviceId, keyId, subject, extensions, options);
		}).then(result => {
			return {
				csr: cleanPemString(result),
				keyPairId: keyId
			};
		}).then(null, e => {
			if(keyId) {
				plugin.deleteKeyPair(deviceId, keyId);
			}
			const err = getError(e);
			throw new Error(err);
		});
	};

	/**
	 * Записать сертификат на токен
	 * @param {string} certificate base64(массив байт со значением сертификата в формате DER)
	 * @returns {Promise}
	 */
	this.writeCertificate = function(certificate){
		const category = plugin.CERT_CATEGORY_USER;
		return plugin.importCertificate(deviceId, certificate, category).then(null, e => {
			const err = getError(e);
			throw new Error(err);
		});
	};

	/**
	 * Получение информации о сертификате.
	 * @param {int} certId идентификатор сертификата
	 * @returns {Promise<Object>}
	 */
	this.certificateInfo = function(certId){
		let hasPrivateKey = false;
		let serialNumber = '';
		return new Promise(resolve => {
			plugin.getKeyByCertificate(deviceId, certId).then(keyId => {
				resolve(!!keyId);
			}).then(null, e => {
				const err = getError(e);
				console.log('getKeyByCertificate', certId, err);
				resolve(false);
			});
		}).then(result => {
			hasPrivateKey = result;
			return plugin.getCertificateInfo(deviceId, certId, plugin.CERT_INFO_SERIAL_NUMBER);
		}).then(result => {
			serialNumber = result;
			return plugin.parseCertificate(deviceId, certId);
		}).then(o => {
			const ver = o.text.match(/Version: (\d+)/);
			const version = ver.length > 1 ? ver[1] : undefined;
			var dn = new DN;
			for(var i in o.subject) {
				var rdn = o.subject[i].rdn;
				var val = o.subject[i].value;
				dn[rdn] = val;
			}
			dn = convertDN(dn);
			var dnI = new DN;
			for(var i in o.issuer) {
				var rdn = o.issuer[i].rdn;
				var val = o.issuer[i].value;
				dnI[rdn] = val;
			}
			var dt = new Date();
			var info = {
				Name: dn.commonName || dn.CN,
				//TODO: Issuer object
				Issuer: dnI,
				IssuerName: dnI.commonName || dnI.CN,
				Subject: dn,
				SubjectName: dn.toString(),
				Version: version,
				SerialNumber: serialNumber,
				Thumbprint: certId.replace(/\:/g, ''),
				ValidFromDate: new Date(o.validNotBefore),
				ValidToDate: new Date(o.validNotAfter),
				HasPrivateKey: hasPrivateKey,
				IsValid: dt >= new Date(o.validNotBefore) && dt <= new Date(o.validNotAfter),
				toString: function(){
					return 'Название:              ' + this.Name +
						'\nИздатель:              ' + this.IssuerName +
						'\nСубъект:               ' + this.SubjectName +
						'\nВерсия:                ' + this.Version +
						'\nСерийный №:            ' + this.SerialNumber +
						'\nОтпечаток SHA1:        ' + this.Thumbprint +
						'\nНе действителен до:    ' + this.ValidFromDate +
						'\nНе действителен после: ' + this.ValidToDate +
						'\nПриватный ключ:        ' + (this.HasPrivateKey ? 'Есть' : 'Нет') +
						'\nВалидный:              ' + (this.IsValid ? 'Да' : 'Нет');
				}
			};
			return info;
		}).then(null, e => {
			const err = getError(e);
			throw new Error(err);
		});
	};

	/**
	 * Получение массива доступных сертификатов
	 * @returns {Promise<Array>} [{id, subject}, ...]
	 */
	this.listCertificates = function(){
		let certIds = [];
		let certs = [];
		return plugin.enumerateCertificates(deviceId, plugin.CERT_CATEGORY_USER).then(results => {
			certIds = results;
			let promises = [];
			for (let i in certIds) {
				promises.push(plugin.parseCertificate(deviceId, certIds[i]));
			}
			return Promise.all(promises);
		}).then(results => {
			for (let i in certIds) {
				certs.push({
					id: certIds[i],
					name: formatCertificateName(results[i])
				});
			}
			return certs;
		}).then(null, e => {
			const err = getError(e);
			throw new Error(err);
		});
	};
	
	/**
	 * Получить сертификат
	 * @param {string} certId 
	 * @returns {Promise<string>} base64(массив байт со значением сертификата в формате DER)
	 */
	this.readCertificate = function(certId){
		return plugin.getCertificate(deviceId, certId).then(result => {
			return cleanPemString(result);
		}).then(null, e => {
			const err = getError(e);
			throw new Error(err);
		});
	};

	/**
	 * Подписать данные. Выдает подпись в формате PKCS#7, опционально закодированную в Base64
	 * @param {string} data данные (и подпись) закодированы в base64
	 * @param {string} certId идентификатор сертификата
	 * @returns {Promise<string>} строка-подпись в формате PKCS#7, закодированная в Base64.
	 */
	this.signData = function(dataBase64, certId){
		const detached = true;
		return plugin.sign(deviceId, certId, dataBase64, plugin.DATA_FORMAT_BASE64, {
			detached
		}).then(null, e => {
			const err = getError(e);
			throw new Error(err);
		});
	};

	/**
	 * Добавить подпись к существующей.
	 * @param {string} dataBase64
	 * @param {string} signBase64 существующая подпись
	 * @param {string} certId идентификатор сертификата
	 * @returns {Promise<string>} base64
	 */
	this.addSign = function(dataBase64, signBase64, certId){
		const detached = true;
		const CMS = signBase64;
		return plugin.sign(deviceId, certId, dataBase64, plugin.DATA_FORMAT_BASE64, {
			detached,
			CMS
		}).then(null, e => {
			const err = getError(e);
			throw new Error(err);
		});
	}

	/**
	 * Проверить подпись.
	 * @param {string} dataBase64
	 * @param {string} signBase64 существующая подпись
	 * @returns {Promise<boolean>} true или reject
	 */
	this.verifySign = function(dataBase64, signBase64){
		const data = dataBase64;
		const base64 = true;
		const verifyCertificate = false;
		return plugin.verify(deviceId, signBase64, {
			data,
			base64,
			verifyCertificate
		}).then(result => {
			if (!result) {
				// потмоу что в крипто-про тоже так
				throw new Error('подпись не верна');
			}
			return true;
		}).then(null, e => {
			const err = getError(e);
			throw new Error(err);
		});
	}

	/**
	 * Получить ошибку по коду
	 * @param {string|Error} e код ошибки или объект
	 * @returns {string} текст ошибки
	 */
	function getError(e) {
		const ee = e.message && e.message.match(/^[0-9]+$/) && e.message || e;
		let mnemo = '';
		if (plugin) for(let i in plugin.errorCodes) {
			if (plugin.errorCodes[i] == ee) {
				mnemo = i;
				break;
			}
		}
		return mnemo && errors[mnemo] || mnemo || e.message || e;
	}

	/**
	 * Получить название сертификата
	 * @param {type} o объект, включающий в себя значения всех полей сертификата.
	 * @param {type} containerName не обязательно
	 * @returns {string} 
	 */
	function formatCertificateName(o, containerName)
	{
		var dn = new DN;
		for(var i in o.subject) {
			var rdn = o.subject[i].rdn;
			var val = o.subject[i].value;
			dn[rdn] = val;
		}
		dn.toString = function(){
			var cn = this['commonName'] || this['CN'] || this['2.5.4.3'];
			var snils = this['СНИЛС'] || this['SNILS'] || this['1.2.643.100.3'];
			var inn = this['ИНН'] || this['INN'] || this['1.2.643.3.131.1.1'];
			return '' + cn + (inn ?  '; ИНН ' + inn : '') + (snils ?  '; СНИЛС ' + snils : '') + (containerName ? ' (' + containerName + ')' : '');
		};
		return dn.toString();
	}

	/**
	 * Убирает все лишнее из PEM, кроме непрерывного base64 
	 * @param {String} pem 
	 * @returns {String}
	 */
	function cleanPemString(pem) {
		return pem.replace(/^-+(BEGIN|END)[^-]+-+$/gm, '').trim();
	}
}

export default RuToken;